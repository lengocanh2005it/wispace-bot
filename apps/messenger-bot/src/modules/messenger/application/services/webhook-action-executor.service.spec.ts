import { WebhookActionExecutorService } from './webhook-action-executor.service';
import type { MessengerWebhookEvent } from '../../domain/entities/messenger.types';
import type { WebhookAction } from '../messenger-webhook.router';
import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';

const buildDeps = (
  overrides: {
    sendText?: jest.Mock;
    mappingService?: Record<string, jest.Mock>;
    linkContextService?: Record<string, jest.Mock>;
    reschedule?: Record<string, jest.Mock>;
  } = {},
) => {
  const outbound = {
    sendTextViaPsid:
      overrides.sendText ?? jest.fn().mockResolvedValue(undefined),
    sendRichFollowUps: jest.fn().mockResolvedValue(undefined),
  };
  const mappingService = {
    linkFromContext: jest.fn().mockResolvedValue({ blocked: false }),
    ...overrides.mappingService,
  };
  const linkContextService = {
    resolveFromRef: jest.fn(),
    ...overrides.linkContextService,
  };
  const service = new WebhookActionExecutorService(
    { get: jest.fn() } as never,
    outbound as never,
    mappingService as never,
    linkContextService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    (overrides.reschedule ?? {}) as never,
    {} as never,
  );
  return { service, outbound, mappingService, linkContextService };
};

describe('WebhookActionExecutorService.cancel_reschedule', () => {
  const event = { sender: { id: 'psid-1' } } as MessengerWebhookEvent;
  const token = '00000000-0000-4000-8000-000000000000';

  it('forwards the current approval token to cancellation', async () => {
    const cancel = jest.fn().mockResolvedValue('Đã hủy');
    const { service } = buildDeps({ reschedule: { cancel } });

    await service.executeAction(
      {
        type: 'cancel_reschedule',
        psid: 'psid-1',
        approvalToken: token,
      },
      event,
      jest.fn().mockResolvedValue(undefined),
    );

    expect(cancel).toHaveBeenCalledWith('psid-1', token);
  });

  it('rejects tokenless cancellation without touching the staged proposal', async () => {
    const cancel = jest.fn();
    const sendText = jest.fn().mockResolvedValue(undefined);
    const { service, outbound } = buildDeps({
      sendText,
      reschedule: { cancel },
    });

    await service.executeAction(
      { type: 'cancel_reschedule', psid: 'psid-1' },
      event,
      jest.fn().mockResolvedValue(undefined),
    );

    expect(cancel).not.toHaveBeenCalled();
    expect(outbound.sendTextViaPsid).toHaveBeenCalledWith(
      expect.objectContaining({
        psid: 'psid-1',
        messageType: 'RESCHEDULE_CANCELLED',
        text: expect.stringContaining('xác thực'),
      }),
    );
  });
});

describe('WebhookActionExecutorService.send_text', () => {
  const buildService = (
    overrides: {
      sendText?: jest.Mock;
    } = {},
  ) => {
    const outbound = {
      sendTextViaPsid:
        overrides.sendText ?? jest.fn().mockResolvedValue(undefined),
      sendRichFollowUps: jest.fn().mockResolvedValue(undefined),
    };
    const service = new WebhookActionExecutorService(
      { get: jest.fn() } as never,
      outbound as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, outbound };
  };

  const action: WebhookAction = {
    type: 'send_text',
    psid: 'psid-1',
    text: 'Chào bạn!',
    messageType: 'WELCOME',
  };

  const event = { sender: { id: 'psid-1' } } as MessengerWebhookEvent;

  it('awaits delivery and resolves when Meta accepts the send', async () => {
    const { service, outbound } = buildService();

    await expect(
      service.executeAction(
        action,
        event,
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toBeUndefined();

    expect(outbound.sendTextViaPsid).toHaveBeenCalledWith({
      psid: 'psid-1',
      text: 'Chào bạn!',
      messageType: 'WELCOME',
    });
  });

  it('propagates delivery failures so the durable inbox retries the event', async () => {
    const sendText = jest
      .fn()
      .mockRejectedValue(new Error('Meta Send API 500'));
    const { service } = buildService({ sendText });

    await expect(
      service.executeAction(
        action,
        event,
        jest.fn().mockResolvedValue(undefined),
      ),
    ).rejects.toThrow('Meta Send API 500');
  });
});

describe('WebhookActionExecutorService.link_user (#383)', () => {
  const event = { sender: { id: 'psid-1' } } as MessengerWebhookEvent;

  it('links through the mapping service without re-submitting the single-use token', async () => {
    const context: MessengerLinkContext = {
      ref: '999',
      topic: 'IELTS',
      cadence: 'WEEKLY',
      userId: 7,
    };
    const { service, mappingService, linkContextService } = buildDeps();

    await service.executeAction(
      { type: 'link_user', psid: 'psid-1', ref: '999', context },
      event,
      jest.fn().mockResolvedValue(undefined),
    );

    expect(mappingService.linkFromContext).toHaveBeenCalledWith(
      'psid-1',
      context,
    );
    expect(linkContextService.resolveFromRef).not.toHaveBeenCalled();
  });

  it('#821: forwards the persisted intent lease to the mapping owner', async () => {
    const context: MessengerLinkContext = {
      ref: '999',
      topic: 'IELTS',
      cadence: 'WEEKLY',
      userId: 7,
    };
    const { service, mappingService } = buildDeps();

    await service.executeAction(
      {
        type: 'link_user',
        psid: 'psid-1',
        ref: '999',
        context,
        intentGeneration: '9',
        intentLeaseToken: 'lease-owner',
      },
      event,
      jest.fn().mockResolvedValue(undefined),
    );

    expect(mappingService.linkFromContext).toHaveBeenCalledWith(
      'psid-1',
      context,
      { intentGeneration: '9', intentLeaseToken: 'lease-owner' },
    );
  });

  it('reports blocked when the mapping service rejects the link', async () => {
    const context: MessengerLinkContext = {
      ref: '999',
      topic: 'IELTS',
      cadence: 'WEEKLY',
      userId: 7,
    };
    const { service, mappingService } = buildDeps({
      mappingService: {
        linkFromContext: jest.fn().mockResolvedValue({ blocked: true }),
      },
    });

    await service.executeAction(
      { type: 'link_user', psid: 'psid-1', ref: '999', context },
      event,
      jest.fn().mockResolvedValue(undefined),
    );

    expect(mappingService.linkFromContext).toHaveBeenCalledTimes(1);
  });

  it('notifies the learner when the fallback link handoff cannot persist', async () => {
    const contextService = {
      resolveFromRef: jest.fn().mockResolvedValue({ handoffFailure: true }),
    };
    const { service, outbound } = buildDeps({
      linkContextService: contextService,
    });

    await service.executeAction(
      { type: 'link_user', psid: 'psid-1', ref: 'token' },
      {
        sender: { id: 'psid-1' },
        referral: { ref: 'token' },
      } as MessengerWebhookEvent,
      jest.fn().mockResolvedValue(undefined),
    );

    expect(outbound.sendTextViaPsid).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: 'MESSENGER_LINK_HANDOFF_FAILED',
      }),
    );
  });
});
