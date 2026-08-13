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
import type { PlatformWebhookInboundEventService } from '@wispace/database';

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
    } as unknown as PlatformWebhookInboundEventService;

    const service = new MessengerService(
      configService,
      repository as never,
      outbound,
      linkContext,
      chatRateLimitConfig,
      actionExecutor,
      inboundEvents,
    );

    return { service, repository, actionExecutor, inboundEvents };
  };

  const payloadWith = (
    events: MessengerWebhookEvent[],
  ): MessengerWebhookPayload => ({
    object: 'page',
    entry: [{ id: 'page-1', time: 1_700_000_000_000, messaging: events }],
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
      'DB down',
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
    ).rejects.toThrow('DB down');
    expect(actionExecutor.executeAction).not.toHaveBeenCalled();
  });
});
