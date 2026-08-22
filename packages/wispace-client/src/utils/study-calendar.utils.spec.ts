import {
  buildEventDateIso,
  formatEventDateForApiWrite,
  parseLocalDatePartsFromEventDate,
  resolveScheduledAtFromEventDate,
  normalizeStudyCalendarTime,
  getLocalDateFromEventDate,
  addDaysToLocalDate,
  resolveRescheduleSlot,
} from './study-calendar.utils';

describe('study-calendar.utils', () => {
  describe('buildEventDateIso', () => {
    it('returns YYYY-MM-DD as-is', () => {
      expect(buildEventDateIso('2026-09-01')).toBe('2026-09-01');
    });

    it.each(['2026-9-1', '2026/09/01', 'not-a-date'])(
      'throws for invalid format: %s',
      (v) => {
        expect(() => buildEventDateIso(v)).toThrow('YYYY-MM-DD');
      },
    );
  });

  describe('formatEventDateForApiWrite', () => {
    it('appends T00:00:00Z to YYYY-MM-DD', () => {
      expect(formatEventDateForApiWrite('2026-09-01')).toBe(
        '2026-09-01T00:00:00Z',
      );
    });

    it('appends Z to ISO datetime without Z', () => {
      expect(formatEventDateForApiWrite('2026-09-01T10:30:00')).toBe(
        '2026-09-01T10:30:00Z',
      );
    });

    it('preserves ISO datetime with Z', () => {
      expect(formatEventDateForApiWrite('2026-09-01T10:30:00Z')).toBe(
        '2026-09-01T10:30:00Z',
      );
    });

    it('trims whitespace', () => {
      expect(formatEventDateForApiWrite('  2026-09-01  ')).toBe(
        '2026-09-01T00:00:00Z',
      );
    });

    it.each(['not-a-date', '2026-13-01'])(
      'throws for invalid format: %s',
      (v) => {
        expect(() => formatEventDateForApiWrite(v)).toThrow(
          'YYYY-MM-DD or ISO-8601',
        );
      },
    );
  });

  describe('parseLocalDatePartsFromEventDate', () => {
    it('parses YYYY-MM-DD directly', () => {
      expect(parseLocalDatePartsFromEventDate('2026-09-01', 'UTC')).toEqual({
        year: 2026,
        month: 9,
        day: 1,
      });
    });

    it('parses ISO datetime via timezone', () => {
      expect(
        parseLocalDatePartsFromEventDate(
          '2026-09-01T05:00:00Z',
          'Asia/Ho_Chi_Minh',
        ),
      ).toEqual({
        year: 2026,
        month: 9,
        day: 1,
      });
    });
  });

  describe('normalizeStudyCalendarTime', () => {
    it.each(['9:00', '09:00', '23:59', '0:00'])('normalizes "%s"', (v) => {
      expect(normalizeStudyCalendarTime(v)).toMatch(/^\d{2}:\d{2}$/);
    });

    it.each(['25:00', '12:60', 'abc', ''])('throws for invalid: "%s"', (v) => {
      expect(() => normalizeStudyCalendarTime(v)).toThrow('HH:mm');
    });
  });

  describe('addDaysToLocalDate', () => {
    it('adds days within same month', () => {
      expect(addDaysToLocalDate('2026-09-01', 5, 'UTC')).toBe('2026-09-06');
    });

    it('adds days across month boundary', () => {
      expect(addDaysToLocalDate('2026-09-28', 5, 'UTC')).toBe('2026-10-03');
    });

    it('handles DST transition', () => {
      expect(addDaysToLocalDate('2026-03-07', 1, 'America/New_York')).toBe(
        '2026-03-08',
      );
    });
  });

  describe('getLocalDateFromEventDate', () => {
    it('extracts YYYY-MM-DD as-is', () => {
      expect(getLocalDateFromEventDate('2026-09-01', 'UTC')).toBe('2026-09-01');
    });

    it('converts ISO datetime to local date', () => {
      expect(
        getLocalDateFromEventDate('2026-09-01T20:00:00Z', 'Asia/Ho_Chi_Minh'),
      ).toBe('2026-09-02');
    });
  });

  describe('resolveScheduledAtFromEventDate', () => {
    it('resolves local date + time to UTC Date', () => {
      const result = resolveScheduledAtFromEventDate(
        '2026-09-01',
        '10:00',
        'UTC',
      );
      expect(result.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    });

    it('handles ICT timezone offset', () => {
      const result = resolveScheduledAtFromEventDate(
        '2026-09-01',
        '10:00',
        'Asia/Ho_Chi_Minh',
      );
      expect(result.toISOString()).toBe('2026-09-01T03:00:00.000Z');
    });

    it('handles DST timezone (EDT)', () => {
      const result = resolveScheduledAtFromEventDate(
        '2026-07-01',
        '10:00',
        'America/New_York',
      );
      expect(result.toISOString()).toBe('2026-07-01T14:00:00.000Z');
    });

    it('handles DST timezone (EST)', () => {
      const result = resolveScheduledAtFromEventDate(
        '2026-01-01',
        '10:00',
        'America/New_York',
      );
      expect(result.toISOString()).toBe('2026-01-01T15:00:00.000Z');
    });

    it('handles Europe/Berlin CET', () => {
      const result = resolveScheduledAtFromEventDate(
        '2026-01-01',
        '10:00',
        'Europe/Berlin',
      );
      expect(result.toISOString()).toBe('2026-01-01T09:00:00.000Z');
    });

    it('handles Europe/Berlin CEST', () => {
      const result = resolveScheduledAtFromEventDate(
        '2026-07-01',
        '10:00',
        'Europe/Berlin',
      );
      expect(result.toISOString()).toBe('2026-07-01T08:00:00.000Z');
    });
  });

  describe('resolveRescheduleSlot', () => {
    it('default_next_day_same_time adds 1 day', () => {
      const result = resolveRescheduleSlot({
        schedulingMode: 'default_next_day_same_time',
        sourceEventDate: '2026-09-01',
        sourceTime: '10:00',
        timezone: 'UTC',
      });
      expect(result.localDate).toBe('2026-09-02');
      expect(result.time).toBe('10:00');
    });

    it('explicit mode with newLocalDate', () => {
      const result = resolveRescheduleSlot({
        schedulingMode: 'explicit',
        sourceEventDate: '2026-09-01',
        sourceTime: '10:00',
        newLocalDate: '2026-09-15',
        timezone: 'UTC',
      });
      expect(result.localDate).toBe('2026-09-15');
      expect(result.time).toBe('10:00');
    });

    it('explicit mode with newTime', () => {
      const result = resolveRescheduleSlot({
        schedulingMode: 'explicit',
        sourceEventDate: '2026-09-01',
        sourceTime: '10:00',
        newTime: '14:30',
        timezone: 'UTC',
      });
      expect(result.localDate).toBe('2026-09-01');
      expect(result.time).toBe('14:30');
    });

    it('throws when sourceTime is missing', () => {
      expect(() =>
        resolveRescheduleSlot({
          schedulingMode: 'default_next_day_same_time',
          sourceEventDate: '2026-09-01',
          sourceTime: null,
          timezone: 'UTC',
        }),
      ).toThrow('không có giờ');
    });

    it('throws when explicit mode has no newLocalDate/newTime', () => {
      expect(() =>
        resolveRescheduleSlot({
          schedulingMode: 'explicit',
          sourceEventDate: '2026-09-01',
          sourceTime: '10:00',
          timezone: 'UTC',
        }),
      ).toThrow('requires newLocalDate and/or newTime');
    });
  });
});
