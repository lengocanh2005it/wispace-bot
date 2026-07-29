import {
  calendarDateToUtcMs,
  daysBetweenCalendarDates,
  resolveExamCountdown,
  formatExamDateDisplay,
  parseExamDateToIso,
  rawDaysUntilExam,
} from './exam-date.utils';

describe('exam-date.utils', () => {
  describe('calendarDateToUtcMs', () => {
    it('converts ISO date to UTC milliseconds', () => {
      expect(calendarDateToUtcMs('2026-07-29')).toBe(Date.UTC(2026, 6, 29));
    });

    it('handles leading/trailing whitespace', () => {
      expect(calendarDateToUtcMs('  2026-01-01  ')).toBe(Date.UTC(2026, 0, 1));
    });

    it('throws on invalid format', () => {
      expect(() => calendarDateToUtcMs('not-a-date')).toThrow(
        'Invalid calendar date',
      );
      expect(() => calendarDateToUtcMs('2026/07/29')).toThrow(
        'Invalid calendar date',
      );
    });
  });

  describe('daysBetweenCalendarDates', () => {
    it('returns positive for future date', () => {
      expect(daysBetweenCalendarDates('2026-07-01', '2026-07-29')).toBe(28);
    });

    it('returns negative for past date', () => {
      expect(daysBetweenCalendarDates('2026-07-29', '2026-07-01')).toBe(-28);
    });

    it('returns 0 for same date', () => {
      expect(daysBetweenCalendarDates('2026-07-29', '2026-07-29')).toBe(0);
    });
  });

  describe('resolveExamCountdown', () => {
    it('returns days until exam and examHasPassed=false for future exam', () => {
      const result = resolveExamCountdown('2026-08-29', '2026-07-29');
      expect(result).toEqual({ daysUntilExam: 31, examHasPassed: false });
    });

    it('returns daysUntilExam=0 and examHasPassed=true for past exam', () => {
      const result = resolveExamCountdown('2026-07-01', '2026-07-29');
      expect(result).toEqual({ daysUntilExam: 0, examHasPassed: true });
    });
  });

  describe('formatExamDateDisplay', () => {
    it('formats ISO to dd/mm/yyyy', () => {
      expect(formatExamDateDisplay('2026-07-29')).toBe('29/07/2026');
    });

    it('returns original string for invalid format', () => {
      expect(formatExamDateDisplay('invalid')).toBe('invalid');
    });
  });

  describe('parseExamDateToIso', () => {
    it('parses dd/mm/yyyy', () => {
      expect(parseExamDateToIso('29/07/2026')).toBe('2026-07-29');
    });

    it('passes through ISO date', () => {
      expect(parseExamDateToIso('2026-07-29')).toBe('2026-07-29');
    });

    it('strips time from ISO datetime', () => {
      expect(parseExamDateToIso('2026-07-29T14:30:00')).toBe('2026-07-29');
      expect(parseExamDateToIso('2026-07-29 14:30')).toBe('2026-07-29');
    });

    it('throws on unsupported format', () => {
      expect(() => parseExamDateToIso('07-29-2026')).toThrow('Unsupported');
    });
  });

  describe('rawDaysUntilExam', () => {
    it('delegates to daysBetweenCalendarDates', () => {
      expect(rawDaysUntilExam('2026-08-29', '2026-07-29')).toBe(31);
    });
  });
});
