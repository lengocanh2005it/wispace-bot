/* eslint-disable @typescript-eslint/unbound-method -- jest.fn() mocks */
import {
  ZaloWebhookIngestService,
  buildZaloEventId,
} from './zalo-webhook-ingest.service';
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
    const inboundEvents = {
      ingest: jest.fn().mockResolvedValue({ inserted: true, id: 7 }),
    } as unknown as PlatformWebhookInboundEventService;

    const service = new ZaloWebhookIngestService(inboundEvents);

    return { service, inboundEvents };
  };

  it('persists an event without dispatching downstream work', async () => {
    const { service, inboundEvents } = buildService();

    const accepted = await service.ingestEvent(textEvent());

    expect(accepted).toBe(true);
    expect(inboundEvents.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'm1',
        externalUserId: 'user-1',
        eventType: 'user_send_text',
      }),
    );
  });

  it('skips duplicate deliveries without claiming or dispatching', async () => {
    const { service, inboundEvents } = buildService();
    (inboundEvents.ingest as jest.Mock).mockResolvedValue({ inserted: false });

    const accepted = await service.ingestEvent(textEvent());

    expect(accepted).toBe(false);
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

  it('generates deterministic content hash when both msg_id and timestamp are missing', () => {
    const event: ZaloWebhookEvent = {
      app_id: 'app-1',
      event_name: 'follow',
      follower: { id: 'u2' },
    };
    const first = buildZaloEventId(event);
    const second = buildZaloEventId(event);
    expect(first).toBe(second);
    expect(first).toMatch(/^follow:u2:[a-f0-9]{64}$/);
  });

  it('same payload always produces the same hash across repeated calls', () => {
    const event: ZaloWebhookEvent = {
      app_id: 'app-1',
      event_name: 'unfollow',
      sender: { id: 'u3' },
      message: { text: 'bye' },
    };
    const ids = Array.from({ length: 10 }, () => buildZaloEventId(event));
    expect(new Set(ids).size).toBe(1);
  });

  it('different payloads produce different hashes', () => {
    const base: ZaloWebhookEvent = {
      app_id: 'app-1',
      event_name: 'follow',
      follower: { id: 'u2' },
    };
    const modified = { ...base, app_id: 'app-2' };
    expect(buildZaloEventId(base)).not.toBe(buildZaloEventId(modified));
  });

  it('propagates an inbox persistence failure so the endpoint does not acknowledge', async () => {
    const { service, inboundEvents } = buildService();
    (inboundEvents.ingest as jest.Mock).mockRejectedValue(new Error('DB down'));

    await expect(service.ingestEvent(textEvent())).rejects.toThrow('DB down');
  });
});
