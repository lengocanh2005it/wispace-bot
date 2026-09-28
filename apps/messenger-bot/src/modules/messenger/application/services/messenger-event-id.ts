import { createHash } from 'node:crypto';
import type { MessengerWebhookEvent } from '../../domain/entities/messenger.types';

/** Maximum length for event IDs stored in varchar(255) DB columns. */
export const MAX_EVENT_ID_LENGTH = 255;

/** Maximum length for idempotency keys stored in varchar(128) DB columns. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

/** Stable per-delivery event id for the durable inbox. */
export function buildEventId(
  event: MessengerWebhookEvent,
  psid: string,
): string {
  if (event.message?.mid) {
    return event.message.mid;
  }
  if (event.timestamp !== undefined) {
    if (event.postback?.payload) {
      const raw = `pb:${psid}:${event.postback.payload}:${event.timestamp}`;
      if (raw.length <= MAX_EVENT_ID_LENGTH) {
        return raw;
      }
      // Bound long payloads: hash the payload to fit within varchar(255)
      const payloadHash = createHash('sha256')
        .update(event.postback.payload)
        .digest('hex')
        .slice(0, 32);
      return `pb:${psid}:${payloadHash}:${event.timestamp}`;
    }
    return `evt:${psid}:${event.timestamp}`;
  }
  const fingerprint = createHash('sha256')
    .update(canonicalize({ psid, event }))
    .digest('hex');
  return `${event.postback?.payload ? 'pb' : 'evt'}:${fingerprint}`;
}

/**
 * Deterministic idempotency key for chat rate limiting, bounded to
 * varchar(128). Uses SHA-256 for collision resistance within the limit.
 */
export function buildIdempotencyKey(
  event: MessengerWebhookEvent,
  psid: string,
): string {
  const raw = buildEventId(event, psid);
  if (raw.length <= MAX_IDEMPOTENCY_KEY_LENGTH) {
    return raw;
  }
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return `idem:${hash}`;
}
