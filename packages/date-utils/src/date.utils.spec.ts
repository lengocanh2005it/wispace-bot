import {
  getDatePartsInTimezone,
  formatLocalDate,
  todayInTimezone,
  tomorrowInTimezone,
} from './date.utils';

describe('date.utils', () => {
  const TZ = 'Asia/Ho_Chi_Minh';

  it('todayInTimezone returns YYYY-MM-DD in the given timezone', () => {
    // 2026-07-29T01:00:00Z = 08:00 ICT same day
    expect(todayInTimezone(TZ, new Date('2026-07-29T01:00:00Z'))).toBe(
      '2026-07-29',
    );
  });

  it('rolls the date across midnight boundary', () => {
    // 2026-07-29T16:00:00Z = 23:00 ICT same day
    expect(todayInTimezone(TZ, new Date('2026-07-29T16:00:00Z'))).toBe(
      '2026-07-29',
    );
    // 2026-07-29T18:00:00Z = 01:00 ICT next day
    expect(todayInTimezone(TZ, new Date('2026-07-29T18:00:00Z'))).toBe(
      '2026-07-30',
    );
  });

  it('getDatePartsInTimezone returns numeric parts', () => {
    expect(
      getDatePartsInTimezone(new Date('2026-07-29T01:00:00Z'), TZ),
    ).toEqual({ year: 2026, month: 7, day: 29 });
  });

  it('formatLocalDate pads month/day', () => {
    expect(formatLocalDate({ year: 2026, month: 3, day: 5 })).toBe(
      '2026-03-05',
    );
  });

  it('tomorrowInTimezone returns the next calendar day', () => {
    expect(tomorrowInTimezone(TZ, new Date('2026-07-29T01:00:00Z'))).toBe(
      '2026-07-30',
    );
    // Across month boundary
    expect(tomorrowInTimezone('UTC', new Date('2026-07-31T12:00:00Z'))).toBe(
      '2026-08-01',
    );
  });
});
