import { todayReportDate } from './report-date.utils';

describe('report-date.utils', () => {
  describe('todayReportDate', () => {
    it('returns YYYY-MM-DD in default ICT timezone', () => {
      const result = todayReportDate();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('uses provided timezone', () => {
      // UTC date might differ from ICT date
      const utcDate = todayReportDate('UTC', new Date('2026-07-29T01:00:00Z'));
      expect(utcDate).toBe('2026-07-29');
    });

    it('handles ICT midnight boundary (UTC+7)', () => {
      // 2026-07-29T00:30:00Z = 2026-07-29T07:30:00 ICT
      const result = todayReportDate(
        'Asia/Ho_Chi_Minh',
        new Date('2026-07-29T00:30:00Z'),
      );
      expect(result).toBe('2026-07-29');
    });

    it('handles different date in UTC vs ICT', () => {
      // 2026-07-28T20:00:00Z = 2026-07-29T03:00:00 ICT
      const result = todayReportDate(
        'Asia/Ho_Chi_Minh',
        new Date('2026-07-28T20:00:00Z'),
      );
      expect(result).toBe('2026-07-29');
    });
  });
});
