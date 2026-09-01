import fc from 'fast-check';
import { parseReportOutput } from './report-formatter';

/**
 * #621 property suite: the LLM report-JSON boundary is a total function —
 * arbitrary model output resolves to `{ headline }` or a clean bounded
 * Error, never a half-populated result; only the prose field is read from
 * the model contract (factual fields are deterministic, #124).
 */
const ARBITRARY_STRING: fc.Arbitrary<string> = fc
  .string({ maxLength: 1024 })
  .chain((s) => fc.constantFrom(s, `${s}{`, `${s}}`, `[${s}]`));

fc.configureGlobal({ numRuns: 200 });

describe('report-formatter.parseReportOutput property (#621 fuzz)', () => {
  it('any string yields { headline } or a bounded Error — never an unhandled throw', () => {
    fc.assert(
      fc.property(ARBITRARY_STRING, (content) => {
        try {
          const prose = parseReportOutput(content);
          expect(Object.keys(prose).sort()).toEqual(['headline']);
          expect(typeof prose.headline).toBe('string');
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
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
