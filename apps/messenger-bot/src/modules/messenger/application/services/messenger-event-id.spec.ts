import {
  buildEventId,
  buildIdempotencyKey,
  MAX_EVENT_ID_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from './messenger.service';
import type { MessengerWebhookEvent } from '../../domain/entities/messenger.types';

describe('buildEventId', () => {
  const psid = 'psid-abc-123';

  it('returns Meta mid when present', () => {
    const event: MessengerWebhookEvent = {
      sender: { id: psid },
      message: { mid: 'm.mid.1234567890' },
    };
    expect(buildEventId(event, psid)).toBe('m.mid.1234567890');
  });

  it('builds postback event ID with timestamp', () => {
    const event: MessengerWebhookEvent = {
      sender: { id: psid },
      timestamp: 1700000000000,
      postback: { payload: 'ACTION_A' },
    };
    expect(buildEventId(event, psid)).toBe(`pb:${psid}:ACTION_A:1700000000000`);
  });

  it('builds postback event ID without timestamp using hash', () => {
    const event: MessengerWebhookEvent = {
      sender: { id: psid },
      postback: { payload: 'ACTION_A' },
    };
    const result = buildEventId(event, psid);
    expect(result).toMatch(/^pb:[a-f0-9]{64}$/);
  });

  it('builds event ID for non-postback with timestamp', () => {
    const event: MessengerWebhookEvent = {
      sender: { id: psid },
      timestamp: 1700000000000,
    };
    expect(buildEventId(event, psid)).toBe(`evt:${psid}:1700000000000`);
  });

  it('bounds long postback payload to varchar(255)', () => {
    const longPayload = 'x'.repeat(1024);
    const event: MessengerWebhookEvent = {
      sender: { id: psid },
      timestamp: 1700000000000,
      postback: { payload: longPayload },
    };
    const result = buildEventId(event, psid);
    expect(result.length).toBeLessThanOrEqual(MAX_EVENT_ID_LENGTH);
    // Should contain hash of payload, not the full payload
    expect(result).not.toContain(longPayload);
    expect(result).toMatch(
      /^pb:psid-[a-z]+-[0-9]+:[a-f0-9]{32}:1700000000000$/,
    );
  });

  it('keeps short postback payload verbatim', () => {
    const shortPayload = 'ACTION_A';
    const event: MessengerWebhookEvent = {
      sender: { id: psid },
      timestamp: 1700000000000,
      postback: { payload: shortPayload },
    };
    const result = buildEventId(event, psid);
    expect(result).toContain(shortPayload);
  });

  it('produces deterministic IDs for same input', () => {
    const event: MessengerWebhookEvent = {
      sender: { id: psid },
      timestamp: 1700000000000,
      postback: { payload: 'ACTION_A' },
    };
    expect(buildEventId(event, psid)).toBe(buildEventId(event, psid));
  });

  it('produces different IDs for different payloads', () => {
    const event1: MessengerWebhookEvent = {
      sender: { id: psid },
      timestamp: 1700000000000,
      postback: { payload: 'ACTION_A' },
    };
    const event2: MessengerWebhookEvent = {
      sender: { id: psid },
      timestamp: 1700000000000,
      postback: { payload: 'ACTION_B' },
    };
    expect(buildEventId(event1, psid)).not.toBe(buildEventId(event2, psid));
  });

  it('handles Unicode payloads', () => {
    const unicodePayload = 'Xin chào thế giới 🌍';
    const event: MessengerWebhookEvent = {
      sender: { id: psid },
      timestamp: 1700000000000,
      postback: { payload: unicodePayload },
    };
    const result = buildEventId(event, psid);
    expect(result.length).toBeLessThanOrEqual(MAX_EVENT_ID_LENGTH);
  });
});

describe('buildIdempotencyKey', () => {
  const psid = 'psid-abc-123';

  it('returns short event ID as-is when within limit', () => {
    const event: MessengerWebhookEvent = {
      sender: { id: psid },
      timestamp: 1700000000000,
      postback: { payload: 'SHORT' },
    };
    const key = buildIdempotencyKey(event, psid);
    expect(key).toBe(buildEventId(event, psid));
    expect(key.length).toBeLessThanOrEqual(MAX_IDEMPOTENCY_KEY_LENGTH);
  });

  it('hashes long event ID to fit varchar(128)', () => {
    const longPayload = 'x'.repeat(200);
    const event: MessengerWebhookEvent = {
      sender: { id: psid },
      timestamp: 1700000000000,
      postback: { payload: longPayload },
    };
    const key = buildIdempotencyKey(event, psid);
    expect(key.length).toBeLessThanOrEqual(MAX_IDEMPOTENCY_KEY_LENGTH);
    expect(key).toMatch(/^idem:[a-f0-9]{32}$/);
  });

  it('produces deterministic keys for same input', () => {
    const event: MessengerWebhookEvent = {
      sender: { id: psid },
      timestamp: 1700000000000,
      postback: { payload: 'ACTION_A' },
    };
    expect(buildIdempotencyKey(event, psid)).toBe(
      buildIdempotencyKey(event, psid),
    );
  });

  it('produces different keys for different payloads', () => {
    const event1: MessengerWebhookEvent = {
      sender: { id: psid },
      timestamp: 1700000000000,
      postback: { payload: 'ACTION_A' },
    };
    const event2: MessengerWebhookEvent = {
      sender: { id: psid },
      timestamp: 1700000000000,
      postback: { payload: 'ACTION_B' },
    };
    expect(buildIdempotencyKey(event1, psid)).not.toBe(
      buildIdempotencyKey(event2, psid),
    );
  });

  it('replay of same event produces same key', () => {
    const event: MessengerWebhookEvent = {
      sender: { id: psid },
      timestamp: 1700000000000,
      postback: { payload: 'x'.repeat(500) },
    };
    const key1 = buildIdempotencyKey(event, psid);
    const key2 = buildIdempotencyKey(event, psid);
    expect(key1).toBe(key2);
  });
});
