import fc from 'fast-check';
import { parseReportOutput } from './report-formatter';

/**
 * #621 property suite: the LLM report-JSON boundary is a total function —
 * arbitrary model output resolves to `{ headline }` or a clean bounded
 * Error, never a half-populated result; only the prose field is read from
 * the model contract (factual fields are deterministic, #124).
 */
/**
 * #621/#1351: the generator must reach the *success* path too. Brace-mangled
 * random strings almost never parse into a valid object with a `headline`,
 * so a suite built only from them would pass vacuously — the guard would be
 * inert in exactly the way #1351 describes.
 */
const VALID_REPORT_JSON: fc.Arbitrary<string> = fc
  .record({
    headline: fc
      .string({ minLength: 1, maxLength: 200 })
      .filter((s) => s.trim().length > 0),
    // Extra model keys must be ignored, never merged into the prose.
    ignored_extra: fc.option(fc.jsonValue(), { nil: undefined }),
  })
  .map((value) => JSON.stringify(value));

const ARBITRARY_STRING: fc.Arbitrary<string> = fc.oneof(
  fc
    .string({ maxLength: 1024 })
    .chain((s) => fc.constantFrom(s, `${s}{`, `${s}}`, `[${s}]`)),
  fc.jsonValue().map((value) => JSON.stringify(value)),
  fc.constantFrom('[]', '[1,2]', 'null', 'true', '42', '"text"', '{}'),
  VALID_REPORT_JSON,
);

fc.configureGlobal({ numRuns: 200 });

/**
 * #1351: classify the outcome first and assert outside the try — a
 * JestAssertionError from a success-path expectation must fail the property
 * instead of being absorbed as "a bounded Error".
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

describe('report-formatter.parseReportOutput property (#621 fuzz)', () => {
  it('any string yields { headline } or a bounded Error — never an unhandled throw', () => {
    fc.assert(
      fc.property(ARBITRARY_STRING, (content) => {
        const outcome = classifyOutcome(() => parseReportOutput(content));
        if (outcome.kind === 'result') {
          expect(Object.keys(outcome.value).sort()).toEqual(['headline']);
          expect(typeof outcome.value.headline).toBe('string');
        } else {
          expect(outcome.error).toBeInstanceOf(Error);
        }
      }),
    );
  });

  it('injected factual fields are ignored — the model only controls the prose (#504/#124)', () => {
    fc.assert(
      fc.property(
        // Whitespace-only headlines reject cleanly (readRequiredStringField)
        // — this property pins the injected-field behavior for real prose.
        fc
          .string({ minLength: 1, maxLength: 300 })
          .filter((s) => s.trim().length > 0),
        fc.integer({ min: 0, max: 9 }),
        (headline, injectedBand) => {
          const content = JSON.stringify({
            headline,
            band: injectedBand,
            streak: injectedBand,
            days_until_exam: injectedBand,
          });
          const prose = parseReportOutput(content);
          expect(prose.headline).toBe(headline.replace(/\s+/g, ' ').trim());
          expect(prose.headline.length).toBeGreaterThan(0);
          expect(Object.keys(prose)).toEqual(['headline']);
        },
      ),
    );
  });

  it('regression #504: prototype-pollution keys stay inert own-data', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('__proto__', 'constructor', 'prototype'),
        fc
          .string({ minLength: 1, maxLength: 200 })
          .filter((s) => s.trim().length > 0),
        (poisonKey, headline) => {
          const content = JSON.stringify({
            [poisonKey]: 'payload',
            headline,
          });
          const prose = parseReportOutput(content);
          expect(prose.headline).toBe(headline.replace(/\s+/g, ' ').trim());
          expect(prose.headline.length).toBeGreaterThan(0);
          expect(Object.getPrototypeOf(prose)).toBe(Object.prototype);
        },
      ),
    );
  });
});
