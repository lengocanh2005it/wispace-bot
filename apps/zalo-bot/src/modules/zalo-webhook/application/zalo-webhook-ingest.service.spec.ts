/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-call -- jest.fn() mocks */
import { ConfigService } from '@nestjs/config';
import {
  ZaloWebhookIngestService,
  buildZaloEventId,
} from './zalo-webhook-ingest.service';
import { ZaloWebhookDispatchService } from './zalo-webhook-dispatch.service';
import type { ZaloWebhookEvent } from '../domain/entities/zalo-webhook-event.types';
import type { PlatformWebhookInboundEventService } from '@wispace/database';

function textEvent(
  overrides: Partial<ZaloWebhookEvent> = {},
): ZaloWebhookEvent {
  return {
    app_id: 'app-1',
    event_name: 'user_send_text',
    sender: { id: 'user-1' },
    message: { text: 'hello', msg_id: 'm1' },
    timestamp: String(Date.now()),
    ...overrides,
  };
}

describe('ZaloWebhookIngestService (durable webhook ingestion)', () => {
  const buildService = () => {
    const configService = {
      get: jest.fn(() => undefined),
    } as unknown as ConfigService;
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const dispatcher = { dispatch } as unknown as ZaloWebhookDispatchService;
    const inboundEvents = {
      ingest: jest.fn().mockResolvedValue({ inserted: true, id: 7 }),
      claim: jest.fn().mockResolvedValue(true),
      markCompleted: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    } as unknown as PlatformWebhookInboundEventService;

    const service = new ZaloWebhookIngestService(
      configService,
      dispatcher,
      inboundEvents,
    );

    return { service, inboundEvents, dispatch };
  };

  it('persists the event before dispatch and marks it completed', async () => {
    const { service, inboundEvents, dispatch } = buildService();

    await service.processEvent(textEvent());

    expect(inboundEvents.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'm1',
        externalUserId: 'user-1',
        eventType: 'user_send_text',
      }),
    );
    expect(dispatch).toHaveBeenCalled();
    expect(inboundEvents.claim).toHaveBeenCalledWith(7);
    expect(inboundEvents.markCompleted).toHaveBeenCalledWith(7);
  });

  it('skips duplicate deliveries without dispatch (idempotent)', async () => {
    const { service, inboundEvents, dispatch } = buildService();
    inboundEvents.ingest.mockResolvedValue({ inserted: false });

    await service.processEvent(textEvent());

    expect(dispatch).not.toHaveBeenCalled();
    expect(inboundEvents.markCompleted).not.toHaveBeenCalled();
  });

  it('defers to the retry cron when the event is already claimed', async () => {
    const { service, inboundEvents, dispatch } = buildService();
    inboundEvents.claim.mockResolvedValue(false);

    await service.processEvent(textEvent());

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('records a bounded-backoff failure when dispatch throws', async () => {
    const { service, inboundEvents, dispatch } = buildService();
    dispatch.mockRejectedValue(new Error('WISPACE down'));

    await service.processEvent(textEvent());

    expect(inboundEvents.markFailed).toHaveBeenCalledWith(
      7,
      'WISPACE down',
      expect.objectContaining({ maxRetries: 5, baseRetryMs: 60_000 }),
    );
    expect(inboundEvents.markCompleted).not.toHaveBeenCalled();
  });

  it('does not schedule a retry when markCompleted fails (side effects already ran)', async () => {
    const { service, inboundEvents } = buildService();
    inboundEvents.markCompleted.mockRejectedValue(new Error('DB hiccup'));

    await service.processEvent(textEvent());

    expect(inboundEvents.markFailed).not.toHaveBeenCalled();
  });

  it('propagates a persistence failure so the endpoint does not acknowledge', async () => {
    const { service, inboundEvents, dispatch } = buildService();
    inboundEvents.ingest.mockRejectedValue(new Error('DB down'));

    await expect(service.processEvent(textEvent())).rejects.toThrow('DB down');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('uses msg_id as the event id for any user_send_* event carrying one', () => {
    const event = textEvent({
      event_name: 'user_send_image',
      message: { text: undefined, msg_id: 'img-9' },
    });
    expect(buildZaloEventId(event)).toBe('img-9');
  });

  it('falls back to a composite id when no msg_id exists', () => {
    const event = textEvent({
      event_name: 'follow',
      sender: undefined,
      follower: { id: 'u2' },
      message: undefined,
    });
    expect(buildZaloEventId(event)).toMatch(/^follow:u2:\d+$/);
  });
});
