import fc from 'fast-check';
import { readValidatedDate, readValidatedTime } from './agent.tools';

/**
 * #621 property suite: the reschedule datetime argument parsers are total
 * functions — arbitrary tool arguments yield undefined or a strictly
 * shaped value; a value that passes the shape check survives re-parsing
 * (no partial acceptance).
 */
fc.configureGlobal({ numRuns: 200 });

const ARBITRARY_VALUE: fc.Arbitrary<unknown> = fc.oneof(
  fc.jsonValue(),
  fc.constantFrom(NaN, Infinity, -Infinity),
);

describe('readValidatedDate/readValidatedTime property (#621 fuzz)', () => {
  it('any tool argument yields undefined or a strict shape — never a throw', () => {
    fc.assert(
      fc.property(ARBITRARY_VALUE, (value) => {
        const date = readValidatedDate(value);
        const time = readValidatedTime(value);
        if (date !== undefined) {
          expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
        if (time !== undefined) {
          expect(time).toMatch(/^\d{2}:\d{2}$/);
        }
      }),
    );
  });

  it('shape-passing values round-trip unchanged', () => {
    const dateGen = fc
      .tuple(fc.nat({ max: 9999 }), fc.nat({ max: 99 }), fc.nat({ max: 99 }))
      .map(
        ([y, m, d]) =>
          `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      );
    const timeGen = fc
      .tuple(fc.nat({ max: 99 }), fc.nat({ max: 99 }))
      .map(
        ([h, m]) =>
          `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
      );
    fc.assert(
      fc.property(dateGen, timeGen, (date, time) => {
        expect(readValidatedDate(date)).toBe(date);
        expect(readValidatedTime(time)).toBe(time);
      }),
    );
  });

  it('regression #545: syntactically-invalid datetime arguments never reach the reschedule math', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant('01/02/2026'),
          fc.constant('9:7'),
          fc.constant('ngày mai'),
          fc.integer({ min: 0, max: 9_999_999 }),
        ),
        (garbage) => {
          // Format-wrong inputs of the WRONG kind are undefined for both
          // parsers; format-matching-but-invalid values (25:00, 2025-02-30)
          // are the documented semantic gap below.
          if (garbage === '25:00') {
            expect(readValidatedDate(garbage)).toBeUndefined();
            expect(readValidatedTime(garbage)).toBe('25:00');
            return;
          }
          expect(readValidatedDate(garbage)).toBeUndefined();
          expect(readValidatedTime(garbage)).toBeUndefined();
        },
      ),
    );
  });

  // #621 finding (documented, not fixed here): the shape regex accepts
  // calendar-invalid values — `2025-02-30` (non-existent date),
  // `2026-13-45` (month 13), and `25:00` (hour 25) all pass, flow into the
  // slot math, and Date arithmetic silently rolls them over. Mitigated in
  // practice by Discord's lead-time assertion and Zalo's text-confirm
  // flow; semantic validation is a deliberate follow-up, not a
  // property-test fix.
  it('regression #545 (semantic gap, documented): calendar-invalid values pass the format check', () => {
    expect(readValidatedDate('2025-02-30')).toBe('2025-02-30');
    expect(readValidatedDate('2026-13-45')).toBe('2026-13-45');
    expect(readValidatedTime('25:00')).toBe('25:00');
  });
});
