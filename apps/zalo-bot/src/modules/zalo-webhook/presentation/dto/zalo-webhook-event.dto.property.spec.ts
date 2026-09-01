import 'reflect-metadata';
import fc from 'fast-check';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ZaloWebhookEventDto } from './zalo-webhook-event.dto';
import { buildZaloEventId } from '../../application/zalo-webhook-ingest.service';

/**
 * #621 property suite: the Zalo webhook DTO boundary is a total function —
 * arbitrary JSON either validates cleanly or yields a well-formed error
 * list, never an unhandled throw; valid events keep only accepted fields
 * (#436/#518).
 */
const ARBITRARY_JSON: fc.Arbitrary<unknown> = fc.jsonValue();

fc.configureGlobal({ numRuns: 200 });

const validateEvent = async (raw: unknown) => {
  // Same boundary guard as the Messenger suite: class-validator throws an
  // unhandled TypeError on null, so non-objects are rejected cleanly first.
  const normalized =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const dto = plainToInstance(ZaloWebhookEventDto, normalized);
  const errors = await validate(dto, { whitelist: true });
  return { dto, errors };
};

const VALID_EVENT_SHAPE = fc.record({
  app_id: fc.string({ minLength: 1, maxLength: 32 }),
  event_name: fc.constantFrom(
    'user_send_text',
    'follow',
    'unfollow',
    'user_send_image',
  ),
  timestamp: fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
  sender: fc.option(fc.record({ id: fc.string({ maxLength: 32 }) }), {
    nil: undefined,
  }),
  message: fc.option(
    fc.record({
      text: fc.string({ maxLength: 200 }),
      msg_id: fc.string({ maxLength: 32 }),
    }),
    { nil: undefined },
  ),
});

describe('ZaloWebhookEventDto property (#621 fuzz)', () => {
  it('any JSON yields a well-formed validation result — never an unhandled throw', async () => {
    await fc.assert(
      fc.asyncProperty(ARBITRARY_JSON, async (raw) => {
        const { errors } = await validateEvent(raw);
        expect(Array.isArray(errors)).toBe(true);
      }),
    );
  });

  it('a valid event keeps only accepted fields (no provider leakage)', async () => {
    await fc.assert(
      fc.asyncProperty(VALID_EVENT_SHAPE, async (raw) => {
        const { dto, errors } = await validateEvent({
          ...raw,
          message: raw.message
            ? { ...raw.message, evil_nested: 'payload' }
            : undefined,
        });
        expect(errors).toHaveLength(0);
        expect(
          Object.keys(dto).every((key) =>
            [
              'app_id',
              'event_name',
              'timestamp',
              'sender',
              'recipient',
              'follower',
              'oa_id',
              'user_id_by_app',
              'message',
            ].includes(key),
          ),
        ).toBe(true);
        // Nested unknown fields are stripped too (#436).
        if (dto.message) {
          expect(dto.message).not.toHaveProperty('evil_nested');
        }
      }),
    );
  });

  it('regression #518: oversized message text is flagged invalid, never consumed', async () => {
    const { errors } = await validateEvent({
      app_id: '123',
      event_name: 'user_send_text',
      sender: { id: 'zalo-1' },
      message: { text: 'x'.repeat(1_048_576), msg_id: 'm-1' },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('regression #436: unknown top-level fields are stripped, never forwarded', async () => {
    const { dto, errors } = await validateEvent({
      app_id: '123',
      event_name: 'user_send_text',
      sender: { id: 'zalo-1' },
      message: { text: 'hi', msg_id: 'm-1' },
      evil_provider_field: { nested: 'payload' },
    });
    expect(errors).toHaveLength(0);
    expect(dto).not.toHaveProperty('evil_provider_field');
  });

  it('regression #483 (family): buildZaloEventId is deterministic for identical inputs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
        fc.option(fc.string({ maxLength: 32 }), { nil: undefined }),
        fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
        async (msgId, senderId, timestamp) => {
          const event = {
            app_id: '123',
            event_name: 'user_send_text' as const,
            timestamp,
            sender: senderId ? { id: senderId } : undefined,
            message: msgId ? { text: 'hi', msg_id: msgId } : undefined,
          };
          const first = buildZaloEventId(event as never);
          expect(buildZaloEventId(structuredClone(event))).toBe(first);
        },
      ),
    );
  });
});
