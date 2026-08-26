/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-call -- jest.fn() mocks */
import { ConfigService } from '@nestjs/config';
import { MessengerService } from './messenger.service';
import type {
  MessengerWebhookEvent,
  MessengerWebhookPayload,
} from '../../domain/entities/messenger.types';
import type { WebhookActionExecutorService } from './webhook-action-executor.service';
import type { MessengerOutboundService } from './messenger-outbound.service';
import type { MessengerLinkContextService } from './messenger-link-context.service';
import type { ChatRateLimitConfigService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit-config.service';
import type { WebhookInboundEventsPort } from '../../domain/repositories/webhook-inbound-events.port';

function textEvent(
  overrides: Partial<MessengerWebhookEvent> = {},
): MessengerWebhookEvent {
  return {
    sender: { id: 'psid-1' },
    recipient: { id: 'page-1' },
    timestamp: 1_700_000_000_000,
    message: { mid: 'mid-1', text: 'xem lich hoc' },
    ...overrides,
  };
}

function postbackEvent(
  overrides: Partial<MessengerWebhookEvent> = {},
): MessengerWebhookEvent {
  return {
    sender: { id: 'psid-1' },
    recipient: { id: 'page-1' },
    timestamp: 1_700_000_000_000,
    postback: { payload: 'GET_LEARNING_REPORT' },
    ...overrides,
  };
}

describe('MessengerService (durable webhook ingestion)', () => {
  const buildService = () => {
    const configService = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;
    const repository = {
      findActiveMappingByPsid: jest.fn().mockResolvedValue(null),
    };
    const outbound = {
      sendSenderActionOptional: jest.fn().mockResolvedValue(undefined),
    } as unknown as MessengerOutboundService;
    const linkContext = {
      resolveFromMapping: jest.fn().mockResolvedValue(undefined),
      resolveFromRef: jest.fn().mockResolvedValue({ context: undefined }),
    } as unknown as MessengerLinkContextService;
    const chatRateLimitConfig = {
      shouldEnforceForPsid: jest.fn().mockReturnValue(false),
    } as unknown as ChatRateLimitConfigService;
    const actionExecutor = {
      executeAction: jest.fn().mockResolvedValue(undefined),
    } as unknown as WebhookActionExecutorService;
    const inboundEvents = {
      ingest: jest.fn().mockResolvedValue({ inserted: true, id: 7 }),
    } as unknown as WebhookInboundEventsPort;

    const service = new MessengerService(
      configService,
      repository as never,
      outbound,
      linkContext,
      chatRateLimitConfig,
      actionExecutor,
      inboundEvents,
    );

    return {
      service,
      repository,
      actionExecutor,
      inboundEvents,
      linkContext,
    };
  };

  const payloadWith = (
    events: MessengerWebhookEvent[],
  ): MessengerWebhookPayload => ({
    object: 'page',
    entry: [{ id: 'page-1', time: 1_700_000_000_000, messaging: events }],
  });

  describe('#383 referral verification (pre-resolve)', () => {
    const verified = {
      ref: '999',
      topic: 'IELTS',
      cadence: 'WEEKLY' as const,
      userId: 999,
    };
    const textWithRef = (mid: string) =>
      textEvent({
        message: { mid, text: 'xem lich hoc', referral: { ref: '999' } },
      });
    const executedActions = (actionExecutor: { executeAction: jest.Mock }) =>
      actionExecutor.executeAction.mock.calls.map((call) => call[0]);

    it('links an unmapped psid from a message referral then routes chat under the new identity', async () => {
      const { service, actionExecutor, linkContext } = buildService();
      (linkContext.resolveFromRef as jest.Mock).mockResolvedValue({
        context: verified,
      });

      await service.processEvent(textWithRef('mid-r1'));

      expect(linkContext.resolveFromRef).toHaveBeenCalledTimes(1);
      const actions = executedActions(actionExecutor);
      expect(actions.map((a) => a.type)).toEqual(['link_user', 'enqueue_chat']);
      expect(actions[0]).toEqual(
        expect.objectContaining({ type: 'link_user', context: verified }),
      );
      expect(actions[1].userId).toBe(999);
      expect(actions[1].idempotencyKey).toBe('mid-r1');
    });

    it('blocks a relink attempt: notice first, no link_user, chat keeps the old identity', async () => {
      const { service, actionExecutor, linkContext, repository } =
        buildService();
      (repository.findActiveMappingByPsid as jest.Mock).mockResolvedValue({
        userId: 143,
        topic: 'IELTS',
        cadence: 'WEEKLY',
      });
      (linkContext.resolveFromRef as jest.Mock).mockResolvedValue({
        context: verified,
      });

      await service.processEvent(textWithRef('mid-r2'));

      const actions = executedActions(actionExecutor);
      expect(actions.map((a) => a.type)).toEqual(['send_text', 'enqueue_chat']);
      expect(actions[0].messageType).toBe('MAPPING_RELINK_BLOCKED');
      expect(actions[1].userId).toBe(143);
    });

    it('verify failure on unmapped psid: single failure notice only', async () => {
      const { service, actionExecutor, linkContext } = buildService();
      (linkContext.resolveFromRef as jest.Mock).mockResolvedValue({
        verifyFailureReason: 'EXPIRED',
      });

      await service.processEvent(textWithRef('mid-r3'));

      const actions = executedActions(actionExecutor);
      expect(actions).toHaveLength(1);
      expect(actions[0].messageType).toBe('MESSENGER_LINK_VERIFY_FAILED');
      expect(actions[0].text).toContain('hết hạn');
    });

    it('verify failure on mapped psid: notice then chat under mapping identity', async () => {
      const { service, actionExecutor, linkContext, repository } =
        buildService();
      (repository.findActiveMappingByPsid as jest.Mock).mockResolvedValue({
        userId: 143,
      });
      (linkContext.resolveFromRef as jest.Mock).mockResolvedValue({
        verifyFailureReason: 'USED',
      });

      await service.processEvent(textWithRef('mid-r4'));

      const actions = executedActions(actionExecutor);
      expect(actions.map((a) => a.type)).toEqual(['send_text', 'enqueue_chat']);
      expect(actions[0].messageType).toBe('MESSENGER_LINK_VERIFY_FAILED');
      expect(actions[1].userId).toBe(143);
    });

    it('optin reuses the pre-verified context without submitting the token twice', async () => {
      const { service, actionExecutor, linkContext } = buildService();
      (linkContext.resolveFromRef as jest.Mock).mockResolvedValue({
        context: verified,
      });

      await service.processEvent(textEvent({ optin: { ref: '999' } }) as never);

      expect(linkContext.resolveFromRef).toHaveBeenCalledTimes(1);
      const actions = executedActions(actionExecutor);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toEqual(
        expect.objectContaining({ type: 'link_user', context: verified }),
      );
    });

    it('plain chat without a ref skips verification entirely', async () => {
      const { service, actionExecutor, linkContext, repository } =
        buildService();
      (repository.findActiveMappingByPsid as jest.Mock).mockResolvedValue({
        userId: 143,
      });

      await service.processEvent(textEvent());

      expect(linkContext.resolveFromRef).not.toHaveBeenCalled();
      expect(executedActions(actionExecutor)[0].type).toBe('enqueue_chat');
    });
  });

  it('persists an event and returns without dispatching it', async () => {
    const { service, inboundEvents, actionExecutor } = buildService();

    const result = await service.handleWebhook(payloadWith([textEvent()]));

    expect(inboundEvents.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'mid-1',
        externalUserId: 'psid-1',
        eventType: 'message',
      }),
    );
    expect(actionExecutor.executeAction).not.toHaveBeenCalled();
    expect(result).toEqual({ accepted: 1, duplicates: 0 });
  });

  it('skips duplicate deliveries without dispatching them', async () => {
    const { service, inboundEvents, actionExecutor } = buildService();
    (inboundEvents.ingest as jest.Mock).mockResolvedValue({ inserted: false });

    const result = await service.handleWebhook(payloadWith([textEvent()]));

    expect(actionExecutor.executeAction).not.toHaveBeenCalled();
    expect(result).toEqual({ accepted: 0, duplicates: 1 });
  });

  it('delegates postback deduplication to the durable inbox', async () => {
    const { service, inboundEvents, actionExecutor } = buildService();
    const event = postbackEvent();
    (inboundEvents.ingest as jest.Mock)
      .mockResolvedValueOnce({ inserted: true, id: 7 })
      .mockResolvedValueOnce({ inserted: false });

    const first = await service.handleWebhook(payloadWith([event]));
    const second = await service.handleWebhook(payloadWith([event]));

    expect(inboundEvents.ingest).toHaveBeenCalledTimes(2);
    expect(first).toEqual({ accepted: 1, duplicates: 0 });
    expect(second).toEqual({ accepted: 0, duplicates: 1 });
    expect(actionExecutor.executeAction).not.toHaveBeenCalled();
  });

  it('allows a postback to retry after the first inbox write fails', async () => {
    const { service, inboundEvents } = buildService();
    const event = postbackEvent();
    (inboundEvents.ingest as jest.Mock)
      .mockRejectedValueOnce(new Error('DB down'))
      .mockResolvedValueOnce({ inserted: true, id: 7 });

    await expect(service.handleWebhook(payloadWith([event]))).rejects.toThrow(
      'Webhook ingestion failed',
    );
    await expect(service.handleWebhook(payloadWith([event]))).resolves.toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(inboundEvents.ingest).toHaveBeenCalledTimes(2);
  });

  it('uses stable event ids for timestamped postbacks', async () => {
    const { service, inboundEvents } = buildService();

    await service.handleWebhook(
      payloadWith([postbackEvent({ timestamp: 1_700_000_001_000 })]),
    );

    expect(inboundEvents.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'pb:psid-1:GET_LEARNING_REPORT:1700000001000',
        eventType: 'postback',
      }),
    );
  });

  it('routes a stored event only through processEvent', async () => {
    const { service, actionExecutor, repository } = buildService();
    repository.findActiveMappingByPsid.mockResolvedValue({ userId: 143 });

    await service.processEvent(textEvent());

    expect(actionExecutor.executeAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'enqueue_chat', userId: 143 }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('propagates downstream processing errors to the retry worker', async () => {
    const { service, actionExecutor, repository } = buildService();
    repository.findActiveMappingByPsid.mockResolvedValue({ userId: 143 });
    actionExecutor.executeAction.mockRejectedValue(new Error('WISPACE down'));

    await expect(service.processEvent(textEvent())).rejects.toThrow(
      'WISPACE down',
    );
  });

  it('propagates an inbox persistence failure so the endpoint does not acknowledge', async () => {
    const { service, inboundEvents, actionExecutor } = buildService();
    (inboundEvents.ingest as jest.Mock).mockRejectedValue(new Error('DB down'));

    await expect(
      service.handleWebhook(payloadWith([textEvent()])),
    ).rejects.toThrow('Webhook ingestion failed');
    expect(actionExecutor.executeAction).not.toHaveBeenCalled();
  });

  it('rejects oversized batches with PayloadTooLargeException (#345)', async () => {
    const configService = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'WEBHOOK_MAX_BATCH_SIZE') return 3;
        return fallback;
      }),
    } as unknown as ConfigService;
    const repository = {
      findActiveMappingByPsid: jest.fn().mockResolvedValue(null),
    };
    const outbound = {} as unknown as MessengerOutboundService;
    const linkContext = {
      resolveFromMapping: jest.fn().mockResolvedValue(undefined),
      resolveFromRef: jest.fn().mockResolvedValue({ context: undefined }),
    } as unknown as MessengerLinkContextService;
    const chatRateLimitConfig = {
      shouldEnforceForPsid: jest.fn().mockReturnValue(false),
    } as unknown as ChatRateLimitConfigService;
    const actionExecutor = {
      executeAction: jest.fn().mockResolvedValue(undefined),
    } as unknown as WebhookActionExecutorService;
    const inboundEvents = {
      ingest: jest.fn().mockResolvedValue({ inserted: true, id: 7 }),
    } as unknown as WebhookInboundEventsPort;

    const service = new MessengerService(
      configService,
      repository as never,
      outbound,
      linkContext,
      chatRateLimitConfig,
      actionExecutor,
      inboundEvents,
    );

    const events = Array.from({ length: 5 }, (_, i) =>
      textEvent({ message: { mid: `mid-${i}`, text: `msg ${i}` } }),
    );

    await expect(service.handleWebhook(payloadWith(events))).rejects.toThrow(
      'exceeds limit',
    );
    expect(inboundEvents.ingest).not.toHaveBeenCalled();
  });

  it('accepts batch within configured limit (#345)', async () => {
    const configService = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'WEBHOOK_MAX_BATCH_SIZE') return 5;
        return fallback;
      }),
    } as unknown as ConfigService;
    const repository = {
      findActiveMappingByPsid: jest.fn().mockResolvedValue(null),
    };
    const outbound = {} as unknown as MessengerOutboundService;
    const linkContext = {
      resolveFromMapping: jest.fn().mockResolvedValue(undefined),
      resolveFromRef: jest.fn().mockResolvedValue({ context: undefined }),
    } as unknown as MessengerLinkContextService;
    const chatRateLimitConfig = {
      shouldEnforceForPsid: jest.fn().mockReturnValue(false),
    } as unknown as ChatRateLimitConfigService;
    const actionExecutor = {
      executeAction: jest.fn().mockResolvedValue(undefined),
    } as unknown as WebhookActionExecutorService;
    const inboundEvents = {
      ingest: jest.fn().mockResolvedValue({ inserted: true, id: 7 }),
    } as unknown as WebhookInboundEventsPort;

    const service = new MessengerService(
      configService,
      repository as never,
      outbound,
      linkContext,
      chatRateLimitConfig,
      actionExecutor,
      inboundEvents,
    );

    const events = Array.from({ length: 5 }, (_, i) =>
      textEvent({ message: { mid: `mid-${i}`, text: `msg ${i}` } }),
    );

    const result = await service.handleWebhook(payloadWith(events));
    expect(result).toEqual({ accepted: 5, duplicates: 0 });
    expect(inboundEvents.ingest).toHaveBeenCalledTimes(5);
  });
});
