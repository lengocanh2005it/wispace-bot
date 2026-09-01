import fc from 'fast-check';
import {
  parseJsonObject,
  readRequiredStringField,
  readRequiredStringArrayField,
} from './llm-json-output.utils';

/**
 * #621 property suite: the LLM JSON-output boundary is a total function —
 * arbitrary model output resolves to a validated shape or a clean bounded
 * Error, never an uncontrolled crash or a half-populated result (#504).
 */
const ARBITRARY_STRING: fc.Arbitrary<string> = fc
  .string({ maxLength: 2048 })
  .chain((s) => fc.constantFrom(s, `${s}{`, `{${s}`, `${s}}`));

fc.configureGlobal({ numRuns: 200 });

describe('llm-json-output.utils property (#621 fuzz)', () => {
  it('parseJsonObject: any string throws a bounded Error or returns an object — never a half-shape', () => {
    fc.assert(
      fc.property(ARBITRARY_STRING, (content) => {
        try {
          const parsed = parseJsonObject(content);
          expect(typeof parsed).toBe('object');
          expect(Array.isArray(parsed)).toBe(false);
          expect(parsed).not.toBeNull();
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          // Diagnostic value stays bounded — no raw-output echo in messages.
          expect((error as Error).message.length).toBeLessThan(1000);
        }
      }),
    );
  });

  it('readRequiredStringField: non-string or empty rejects, strings are sanitized and capped', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (rawValue) => {
        const record: Record<string, unknown> = { headline: rawValue };
        try {
          const text = readRequiredStringField(record, 'headline', {
            maxChars: 600,
          });
          expect(text.length).toBeLessThanOrEqual(603); // cap + "..."
          expect(text.trim().length).toBeGreaterThan(0);
        } catch (error) {
          expect((error as Error).message).toContain('headline');
        }
      }),
    );
  });

  it('readRequiredStringArrayField: arrays yield bounded non-empty items or reject', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { maxLength: 20 }), (rawArray) => {
        const record: Record<string, unknown> = { steps: rawArray };
        try {
          const items = readRequiredStringArrayField(record, 'steps');
          expect(items.length).toBeGreaterThan(0);
          expect(items.length).toBeLessThanOrEqual(8);
          for (const item of items) {
            expect(typeof item).toBe('string');
            expect(item.length).toBeLessThanOrEqual(183);
            expect(item.length).toBeGreaterThan(0);
          }
        } catch (error) {
          expect((error as Error).message).toContain('steps');
        }
      }),
    );
  });

  it('regression #504: prototype-pollution keys cannot break the record contract', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('__proto__', 'constructor', 'prototype'),
        fc.string({ minLength: 0, maxLength: 100 }),
        (poisonKey, filler) => {
          const content = JSON.stringify({
            [poisonKey]: filler,
            headline: 'Real headline',
          });
          const parsed = parseJsonObject(content);
          // The parsed record keeps the poison key as inert own-data — the
          // prototype itself is untouched and reads stay own-property based.
          expect(parsed.headline).toBe('Real headline');
          expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
        },
      ),
    );
  });
});
