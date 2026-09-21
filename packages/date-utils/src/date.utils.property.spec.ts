import fc from 'fast-check';
import {
  formatLocalDate,
  getDatePartsInTimezone,
  todayInTimezone,
  tomorrowInTimezone,
} from './date.utils';

fc.configureGlobal({ numRuns: 200 });

const TIMEZONES = [
  'UTC',
  'Asia/Ho_Chi_Minh',
  'America/New_York',
  'Europe/Berlin',
  'Pacific/Auckland',
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
] as const;

const INSTANT = fc.date({
  min: new Date('2000-01-01T00:00:00.000Z'),
  max: new Date('2030-12-31T23:59:59.999Z'),
  noInvalidDate: true,
});

describe('date utility properties', () => {
  it('returns the exact next local calendar date for every supported offset', () => {
    fc.assert(
      fc.property(INSTANT, fc.constantFrom(...TIMEZONES), (now, timezone) => {
        const today = getDatePartsInTimezone(now, timezone);
        const next = new Date(
          Date.UTC(today.year, today.month - 1, today.day + 1),
        );
        const expected = formatLocalDate({
          year: next.getUTCFullYear(),
          month: next.getUTCMonth() + 1,
          day: next.getUTCDate(),
        });

        expect(tomorrowInTimezone(timezone, now)).toBe(expected);
      }),
    );
  });

  it('always formats the current local date as YYYY-MM-DD', () => {
    fc.assert(
      fc.property(INSTANT, fc.constantFrom(...TIMEZONES), (now, timezone) => {
        expect(todayInTimezone(timezone, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }),
    );
  });
});
