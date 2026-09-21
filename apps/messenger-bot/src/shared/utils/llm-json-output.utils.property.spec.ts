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
 *
 * #1351: the guard must be able to fail. Two silent failure modes are fixed
 * below — (a) a success-path assertion swallowed by the surrounding `catch`,
 * and (b) a generator that can never produce the counterexample class
 * (valid JSON of the wrong shape, plus a reachable success-path payload).
 */
const ARBITRARY_STRING: fc.Arbitrary<string> = fc.oneof(
  fc
    .string({ maxLength: 2048 })
    .chain((s) => fc.constantFrom(s, `${s}{`, `{${s}`, `${s}}`)),
  fc.jsonValue().map((value) => JSON.stringify(value)),
  fc.constantFrom('[]', '[1,2,3]', 'null', 'true', '42', '"text"', '{}'),
);

/**
 * #1351: run the boundary call and classify the outcome WITHOUT asserting
 * inside the try. A JestAssertionError thrown by a success-path expectation
 * propagates out of the classifier (it is not caught here), so it fails the
 * property instead of being absorbed as "a bounded Error".
 */
type ClassifiedOutcome<T> =
  | { kind: 'result'; value: T }
  | { kind: 'error'; error: unknown };

function classifyOutcome<T>(fn: () => T): ClassifiedOutcome<T> {
  try {
    return { kind: 'result', value: fn() };
  } catch (error) {
    return { kind: 'error', error };
  }
}

fc.configureGlobal({ numRuns: 200 });

describe('llm-json-output.utils property (#621 fuzz)', () => {
  it('parseJsonObject: any string throws a bounded Error or returns an object — never a half-shape', () => {
    fc.assert(
      fc.property(ARBITRARY_STRING, (content) => {
        // #1351: classify the outcome first, assert outside the try — a
        // JestAssertionError thrown by a success-path expectation must fail
        // the property, not be absorbed as "a bounded Error".
        const outcome = classifyOutcome(() => parseJsonObject(content));
        if (outcome.kind === 'result') {
          expect(typeof outcome.value).toBe('object');
          expect(Array.isArray(outcome.value)).toBe(false);
          expect(outcome.value).not.toBeNull();
        } else {
          expect(outcome.error).toBeInstanceOf(Error);
          // Diagnostic value stays bounded — no raw-output echo in messages.
          expect((outcome.error as Error).message.length).toBeLessThan(1000);
        }
      }),
    );
  });

  it('readRequiredStringField: non-string or empty rejects, strings are sanitized and capped', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (rawValue) => {
        const record: Record<string, unknown> = { headline: rawValue };
        const outcome = classifyOutcome(() =>
          readRequiredStringField(record, 'headline', {
            maxChars: 600,
          }),
        );
        if (outcome.kind === 'result') {
          expect(outcome.value.length).toBeLessThanOrEqual(603); // cap + "..."
          expect(outcome.value.trim().length).toBeGreaterThan(0);
        } else {
          expect((outcome.error as Error).message).toContain('headline');
        }
      }),
    );
  });

  it('readRequiredStringArrayField: arrays yield bounded non-empty items or reject', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { maxLength: 20 }), (rawArray) => {
        const record: Record<string, unknown> = { steps: rawArray };
        const outcome = classifyOutcome(() =>
          readRequiredStringArrayField(record, 'steps'),
        );
        if (outcome.kind === 'result') {
          const items = outcome.value;
          expect(items.length).toBeGreaterThan(0);
          expect(items.length).toBeLessThanOrEqual(8);
          for (const item of items) {
            expect(typeof item).toBe('string');
            expect(item.length).toBeLessThanOrEqual(183);
            expect(item.length).toBeGreaterThan(0);
          }
        } else {
          expect((outcome.error as Error).message).toContain('steps');
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
