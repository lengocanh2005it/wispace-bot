import fc from 'fast-check';
import {
  resolveRescheduleSlot,
  resolveScheduledAtFromEventDate,
} from '@wispace/wispace-client';

/**
 * #621 property suite: the reschedule slot math is a deterministic pure
 * function — same inputs always produce the same slot and the same
 * scheduled instant (cross-platform parity is structural: Messenger,
 * Discord, and Zalo all consume this shared math through the same
 * wispace-client utils).
 */
fc.configureGlobal({ numRuns: 200 });

const TIMEZONE = 'Asia/Ho_Chi_Minh';

// A generator for real local dates (YYYY-MM-DD) — the slot math's input
// contract; semantic validation gaps are pinned in the readValidated*
// suite (agent.tools.property.spec.ts).
const LOCAL_DATE = fc
  .tuple(
    fc.integer({ min: 2024, max: 2027 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(
    ([y, m, d]) =>
      `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
  );

const HHMM = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
  .map(
    ([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
  );

describe('reschedule slot math property (#621 fuzz)', () => {
  it('explicit mode is deterministic: same input, same slot or the same clean rejection', () => {
    fc.assert(
      fc.property(
        LOCAL_DATE,
        HHMM,
        fc.option(LOCAL_DATE, { nil: undefined }),
        fc.option(HHMM, { nil: undefined }),
        (sourceDate, sourceTime, newDate, newTime) => {
          const run = () =>
            resolveRescheduleSlot({
              schedulingMode: 'explicit',
              sourceEventDate: sourceDate,
              sourceTime,
              newLocalDate: newDate,
              newTime: newTime,
              timezone: TIMEZONE,
            });
          // No target given at all → the same clean rejection both times;
          // otherwise the same slot and the same scheduled instant.
          if (!newDate && !newTime) {
            expect(run).toThrow(
              'schedulingMode=explicit requires newLocalDate and/or newTime.',
            );
            return;
          }
          const first = run();
          const second = run();
          expect(second).toEqual(first);
          expect(
            resolveScheduledAtFromEventDate(
              first.eventDate,
              first.time,
              TIMEZONE,
            ).getTime(),
          ).toBe(
            resolveScheduledAtFromEventDate(
              second.eventDate,
              second.time,
              TIMEZONE,
            ).getTime(),
          );
        },
      ),
    );
  });

  it('default mode always lands on source date + 1 day, same time', () => {
    fc.assert(
      fc.property(LOCAL_DATE, HHMM, (sourceDate, sourceTime) => {
        const slot = resolveRescheduleSlot({
          schedulingMode: 'default_next_day_same_time',
          sourceEventDate: sourceDate,
          sourceTime,
          timezone: TIMEZONE,
        });
        const [y, m, d] = sourceDate.split('-').map(Number);
        const expected = new Date(Date.UTC(y, m - 1, d + 1, 12));
        expect(slot.eventDate).toBe(
          `${expected.getUTCFullYear()}-${String(expected.getUTCMonth() + 1).padStart(2, '0')}-${String(expected.getUTCDate()).padStart(2, '0')}`,
        );
        expect(slot.time).toBe(sourceTime);
      }),
    );
  });

  it('missing source time rejects cleanly in every mode', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'default_next_day_same_time' as const,
          'explicit' as const,
        ),
        fc.constantFrom('', '   ', null as unknown as string),
        (mode, emptyTime) => {
          expect(() =>
            resolveRescheduleSlot({
              schedulingMode: mode,
              sourceEventDate: '2026-03-10',
              sourceTime: emptyTime,
              timezone: TIMEZONE,
            }),
          ).toThrow('Buổi học hiện tại không có giờ');
        },
      ),
    );
  });
});
