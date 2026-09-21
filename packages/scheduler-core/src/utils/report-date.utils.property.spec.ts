import fc from 'fast-check';
import { startOfReportDay, todayReportDate } from './report-date.utils';

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

describe('report date utility properties', () => {
  it('starts the same report day that it labels', () => {
    fc.assert(
      fc.property(INSTANT, fc.constantFrom(...TIMEZONES), (now, timezone) => {
        const start = startOfReportDay(timezone, now);

        expect(todayReportDate(timezone, start)).toBe(
          todayReportDate(timezone, now),
        );
        expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
      }),
    );
  });
});
