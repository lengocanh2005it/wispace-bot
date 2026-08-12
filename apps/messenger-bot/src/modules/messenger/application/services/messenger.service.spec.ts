/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- jest.fn() mocks */
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
      markCompleted: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
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

    return {
      service,
      repository,
      actionExecutor,
      inboundEvents,
      configService,
    };
  };

  const payloadWith = (
    events: MessengerWebhookEvent[],
  ): MessengerWebhookPayload => ({
    object: 'page',
    entry: [{ id: 'page-1', time: 1_700_000_000_000, messaging: events }],
  });

  it('persists each event before processing and marks it completed', async () => {
    const { service, inboundEvents, actionExecutor } = buildService();

    const result = await service.handleWebhook(payloadWith([textEvent()]));

    expect(inboundEvents.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'mid-1',
        externalUserId: 'psid-1',
        eventType: 'message',
        rawPayload: expect.objectContaining({ sender: { id: 'psid-1' } }),
      }),
    );
    expect(actionExecutor.executeAction).toHaveBeenCalled();
    expect(inboundEvents.markCompleted).toHaveBeenCalledWith(7);
    expect(result.processed).toBe(1);
    expect(result.failures).toHaveLength(0);
  });

  it('skips duplicate deliveries without processing (idempotent)', async () => {
    const { service, inboundEvents, actionExecutor } = buildService();
    inboundEvents.ingest.mockResolvedValue({ inserted: false });

    const result = await service.handleWebhook(payloadWith([textEvent()]));

    expect(actionExecutor.executeAction).not.toHaveBeenCalled();
    expect(inboundEvents.markCompleted).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
  });

  it('uses a stable postback event id including the delivery timestamp', async () => {
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

  it('marks the event failed with backoff when processing throws (retryable)', async () => {
    const { service, inboundEvents, actionExecutor } = buildService();
    actionExecutor.executeAction = jest
      .fn()
      .mockRejectedValue(new Error('WISPACE down'));

    const result = await service.handleWebhook(payloadWith([textEvent()]));

    expect(inboundEvents.markFailed).toHaveBeenCalledWith(
      7,
      'WISPACE down',
      expect.objectContaining({ maxRetries: 5, baseRetryMs: 60_000 }),
    );
    expect(result.failures).toEqual([
      { psid: 'psid-1', error: 'WISPACE down' },
    ]);
  });

  it('propagates a persistence failure so the endpoint does not acknowledge', async () => {
    const { service, inboundEvents, actionExecutor } = buildService();
    inboundEvents.ingest.mockRejectedValue(new Error('DB down'));

    await expect(
      service.handleWebhook(payloadWith([textEvent()])),
    ).rejects.toThrow('DB down');
    expect(actionExecutor.executeAction).not.toHaveBeenCalled();
  });
});
