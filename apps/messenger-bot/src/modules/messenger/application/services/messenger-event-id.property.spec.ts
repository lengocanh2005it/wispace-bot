import fc from 'fast-check';
import {
  buildEventId,
  buildIdempotencyKey,
  MAX_EVENT_ID_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from './messenger.service';
import type { MessengerWebhookEvent } from '../../domain/entities/messenger.types';

fc.configureGlobal({ numRuns: 200 });

const PSID = fc.string({ minLength: 1, maxLength: 32 });
const MESSENGER_EVENT: fc.Arbitrary<MessengerWebhookEvent> = fc.record({
  sender: fc.record({ id: fc.string({ maxLength: 32 }) }),
  timestamp: fc.option(fc.integer({ min: 0, max: 4_102_444_800_000 }), {
    nil: undefined,
  }),
  message: fc.option(
    fc.record({
      mid: fc.string({ maxLength: 200 }),
      text: fc.string({ maxLength: 100 }),
    }),
    { nil: undefined },
  ),
  postback: fc.option(fc.record({ payload: fc.string({ maxLength: 300 }) }), {
    nil: undefined,
  }),
});

function reorderObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderObjectKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reorderObjectKeys(entry)]),
    );
  }
  return value;
}

describe('Messenger event ID properties', () => {
  it('keeps event and idempotency IDs within storage limits', () => {
    fc.assert(
      fc.property(MESSENGER_EVENT, PSID, (event, psid) => {
        const eventId = buildEventId(event, psid);
        const idempotencyKey = buildIdempotencyKey(event, psid);

        expect(eventId.length).toBeLessThanOrEqual(MAX_EVENT_ID_LENGTH);
        expect(idempotencyKey.length).toBeLessThanOrEqual(
          MAX_IDEMPOTENCY_KEY_LENGTH,
        );
        expect(buildEventId(structuredClone(event), psid)).toBe(eventId);
        expect(buildIdempotencyKey(structuredClone(event), psid)).toBe(
          idempotencyKey,
        );
      }),
    );
  });

  it('ignores object key order for content fingerprints', () => {
    fc.assert(
      fc.property(
        MESSENGER_EVENT.map((event) => ({
          ...event,
          timestamp: undefined,
          message: undefined,
        })),
        PSID,
        (event, psid) => {
          expect(
            buildEventId(
              reorderObjectKeys(event) as MessengerWebhookEvent,
              psid,
            ),
          ).toBe(buildEventId(event, psid));
        },
      ),
    );
  });
});
