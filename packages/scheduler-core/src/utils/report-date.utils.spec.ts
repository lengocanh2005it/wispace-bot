import { startOfReportDay, todayReportDate } from './report-date.utils';

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

  describe('startOfReportDay', () => {
    it('returns local midnight ICT, not process-local midnight (#968)', () => {
      // 2026-07-29T03:00:00 ICT — the window must start at 2026-07-29T00:00 ICT
      // (2026-07-28T17:00Z), not at midnight UTC (2026-07-29T00:00Z), which
      // would exclude the whole 00:00-07:00 ICT band.
      const result = startOfReportDay(
        'Asia/Ho_Chi_Minh',
        new Date('2026-07-28T20:00:00Z'),
      );
      expect(result.toISOString()).toBe('2026-07-28T17:00:00.000Z');
    });

    it('agrees with todayReportDate on the day it starts', () => {
      const now = new Date('2026-07-28T20:00:00Z');
      const start = startOfReportDay('Asia/Ho_Chi_Minh', now);
      expect(todayReportDate('Asia/Ho_Chi_Minh', start)).toBe(
        todayReportDate('Asia/Ho_Chi_Minh', now),
      );
    });

    it('brackets the instant it was derived from', () => {
      const now = new Date('2026-07-29T05:30:00Z');
      const start = startOfReportDay('Asia/Ho_Chi_Minh', now);
      expect(start.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(now.getTime() - start.getTime()).toBeLessThan(24 * 3600 * 1000);
    });

    it('is exact midnight UTC for UTC', () => {
      const result = startOfReportDay('UTC', new Date('2026-07-29T13:45:00Z'));
      expect(result.toISOString()).toBe('2026-07-29T00:00:00.000Z');
    });

    it('resolves local midnight on a DST spring-forward day', () => {
      // Berlin springs forward at 02:00 local on 2026-03-29; local midnight is
      // still CET (+01:00), so the day starts at 2026-03-28T23:00Z.
      const result = startOfReportDay(
        'Europe/Berlin',
        new Date('2026-03-29T10:00:00Z'),
      );
      expect(result.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    });

    it('resolves local midnight on a DST fall-back day', () => {
      // Berlin falls back at 03:00 local on 2026-10-25; local midnight is
      // still CEST (+02:00), so the day starts at 2026-10-24T22:00Z.
      const result = startOfReportDay(
        'Europe/Berlin',
        new Date('2026-10-25T12:00:00Z'),
      );
      expect(result.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    });
  });
});
