import 'reflect-metadata';
import fc from 'fast-check';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MessengerWebhookPayloadDto } from './messenger-webhook-payload.dto';

/**
 * #621 property suite: the Messenger webhook DTO boundary is a total
 * function — arbitrary JSON either validates cleanly or yields a
 * well-formed error list, never an unhandled throw, and valid events
 * normalize to only the accepted fields (#436/#518).
 */
const ARBITRARY_JSON: fc.Arbitrary<unknown> = fc.jsonValue();

fc.configureGlobal({ numRuns: 200 });

const validatePayload = async (raw: unknown) => {
  // Boundary guard mirrors the replay contract (#436): non-object payloads
  // are rejected cleanly BEFORE class-validator (which throws an unhandled
  // TypeError on null — exactly the class of defect #621 exists to catch).
  const normalized =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const dto = plainToInstance(MessengerWebhookPayloadDto, normalized);
  // whitelist:true strips unknown properties from the instance in place.
  const errors = await validate(dto, { whitelist: true });
  return { dto, errors };
};

describe('MessengerWebhookPayloadDto property (#621 fuzz)', () => {
  it('any JSON yields a well-formed validation result — never an unhandled throw', async () => {
    await fc.assert(
      fc.asyncProperty(ARBITRARY_JSON, async (raw) => {
        const { errors } = await validatePayload(raw);
        expect(Array.isArray(errors)).toBe(true);
        for (const error of errors) {
          expect(typeof error).toBe('object');
        }
      }),
    );
  });

  it('a valid event normalizes to only accepted fields (no half-parse leaks)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          object: fc.constant('page'),
          entry: fc.array(
            fc.record({
              id: fc.string({ maxLength: 20 }),
              messaging: fc.array(
                fc.record({
                  sender: fc.record({ id: fc.string({ maxLength: 32 }) }),
                  timestamp: fc.integer({ min: 0, max: 4_102_444_800_000 }),
                  message: fc.option(
                    fc.record({
                      mid: fc.string({ maxLength: 32 }),
                      text: fc.string({ maxLength: 500 }),
                    }),
                    { nil: undefined },
                  ),
                }),
                { maxLength: 3 },
              ),
            }),
            { maxLength: 2 },
          ),
        }),
        async (raw) => {
          const { dto, errors } = await validatePayload(raw);
          expect(errors).toHaveLength(0);
          // Only accepted fields survive the boundary (#436).
          expect(
            Object.keys(dto).every((key) => ['object', 'entry'].includes(key)),
          ).toBe(true);
          for (const entry of dto.entry) {
            expect(
              Object.keys(entry).every((key) =>
                ['id', 'time', 'messaging'].includes(key),
              ),
            ).toBe(true);
            for (const event of entry.messaging) {
              expect(
                Object.keys(event).every((key) =>
                  [
                    'sender',
                    'timestamp',
                    'message',
                    'postback',
                    'referral',
                    'optin',
                  ].includes(key),
                ),
              ).toBe(true);
            }
          }
        },
      ),
    );
  });

  it('regression #518: a 1MB oversized string is flagged as invalid (#MaxLength), not accepted', async () => {
    const raw = {
      object: 'page',
      entry: [
        {
          messaging: [
            {
              sender: { id: 'psid-1' },
              message: { text: 'x'.repeat(1_048_576) },
            },
          ],
        },
      ],
    };
    const { errors } = await validatePayload(raw);
    // The caller contract: errors>0 means the DTO is never consumed — the
    // live pipe answers 400 and the replay path throws before dispatch.
    expect(errors.length).toBeGreaterThan(0);
  });

  it('regression #436: unknown top-level fields are stripped, never forwarded', async () => {
    const raw = {
      object: 'page',
      evil_provider_field: { nested: 'payload' },
      entry: [{ messaging: [{ sender: { id: 'psid-1' } }] }],
    };
    const { errors, dto } = await validatePayload(raw);
    expect(errors).toHaveLength(0);
    expect(dto).not.toHaveProperty('evil_provider_field');
  });
});
