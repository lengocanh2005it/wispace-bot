import {
  computeRemindAt,
  formatScheduledTimeLabel,
  getMinutesUntilSession,
  isSessionStarted,
} from './schedule';

describe('computeRemindAt', () => {
  it('subtracts minutesBefore from the scheduled time', () => {
    const scheduledAt = new Date('2026-07-10T10:00:00Z');
    expect(computeRemindAt(scheduledAt, 15).toISOString()).toBe(
      '2026-07-10T09:45:00.000Z',
    );
  });
});

describe('getMinutesUntilSession', () => {
  it('returns positive minutes for a future session', () => {
    const now = new Date('2026-07-10T09:00:00Z');
    const scheduledAt = new Date('2026-07-10T09:30:00Z');
    expect(getMinutesUntilSession(scheduledAt, now)).toBe(30);
  });

  it('returns negative minutes for a past session', () => {
    const now = new Date('2026-07-10T09:30:00Z');
    const scheduledAt = new Date('2026-07-10T09:00:00Z');
    expect(getMinutesUntilSession(scheduledAt, now)).toBe(-30);
  });
});

describe('isSessionStarted', () => {
  it('is false when well before minLeadMinutes', () => {
    const now = new Date('2026-07-10T09:00:00Z');
    const scheduledAt = new Date('2026-07-10T09:30:00Z');
    expect(isSessionStarted(scheduledAt, 5, now)).toBe(false);
  });

  it('is true within minLeadMinutes of the session', () => {
    const now = new Date('2026-07-10T09:27:00Z');
    const scheduledAt = new Date('2026-07-10T09:30:00Z');
    expect(isSessionStarted(scheduledAt, 5, now)).toBe(true);
  });

  it('is true once the session has started', () => {
    const now = new Date('2026-07-10T09:35:00Z');
    const scheduledAt = new Date('2026-07-10T09:30:00Z');
    expect(isSessionStarted(scheduledAt, 5, now)).toBe(true);
  });
});

describe('formatScheduledTimeLabel', () => {
  const timezone = 'Asia/Ho_Chi_Minh'; // UTC+7

  it('labels a same-day session as "Hôm nay"', () => {
    const now = new Date('2026-07-10T02:00:00Z'); // 09:00 local
    const scheduledAt = new Date('2026-07-10T10:00:00Z'); // 17:00 local
    expect(formatScheduledTimeLabel(scheduledAt, timezone, now)).toBe(
      'Hôm nay lúc 17:00',
    );
  });

  it('labels a next-day session as "Ngày mai"', () => {
    const now = new Date('2026-07-10T02:00:00Z'); // 2026-07-10 local
    const scheduledAt = new Date('2026-07-11T03:00:00Z'); // 2026-07-11 10:00 local
    expect(formatScheduledTimeLabel(scheduledAt, timezone, now)).toBe(
      'Ngày mai lúc 10:00',
    );
  });

  it('labels a further-out session with a full date', () => {
    const now = new Date('2026-07-10T02:00:00Z');
    const scheduledAt = new Date('2026-07-20T03:00:00Z'); // 2026-07-20 10:00 local
    expect(formatScheduledTimeLabel(scheduledAt, timezone, now)).toBe(
      '20/07/2026 lúc 10:00',
    );
  });

  describe('DST transitions', () => {
    // America/New_York 2026: Spring forward March 8 2:00am → 3:00am
    it('America/New_York spring-forward: "Hôm nay" across DST jump', () => {
      // 2026-03-08T07:00Z = 2026-03-08 03:00 EDT (after spring-forward)
      const now = new Date('2026-03-08T07:00:00Z');
      const scheduledAt = new Date('2026-03-08T10:00:00Z'); // 06:00 EDT
      expect(
        formatScheduledTimeLabel(scheduledAt, 'America/New_York', now),
      ).toBe('Hôm nay lúc 06:00');
    });

    it('America/New_York spring-forward: "Ngày mai" across DST jump', () => {
      // 2026-03-07T20:00Z = 2026-03-07 15:00 EST (before spring-forward)
      const now = new Date('2026-03-07T20:00:00Z');
      const scheduledAt = new Date('2026-03-08T10:00:00Z'); // 06:00 EDT (next day, DST)
      expect(
        formatScheduledTimeLabel(scheduledAt, 'America/New_York', now),
      ).toBe('Ngày mai lúc 06:00');
    });

    // America/New_York 2026: Fall back November 1 2:00am → 1:00am
    it('America/New_York fall-back: "Hôm nay" across DST rollback', () => {
      // 2026-11-01T07:00Z = 2026-11-01 02:00 EST (after fall-back)
      const now = new Date('2026-11-01T07:00:00Z');
      const scheduledAt = new Date('2026-11-01T10:00:00Z'); // 05:00 EST
      expect(
        formatScheduledTimeLabel(scheduledAt, 'America/New_York', now),
      ).toBe('Hôm nay lúc 05:00');
    });

    // Europe/Berlin 2026: Spring forward March 29 2:00am → 3:00am
    it('Europe/Berlin spring-forward: "Hôm nay" across DST jump', () => {
      // 2026-03-29T01:00Z = 2026-03-29 02:00 CEST (after spring-forward)
      const now = new Date('2026-03-29T01:00:00Z');
      const scheduledAt = new Date('2026-03-29T10:00:00Z'); // 12:00 CEST
      expect(formatScheduledTimeLabel(scheduledAt, 'Europe/Berlin', now)).toBe(
        'Hôm nay lúc 12:00',
      );
    });

    // Europe/Berlin 2026: Fall back October 25 3:00am → 2:00am
    it('Europe/Berlin fall-back: "Ngày mai" across DST rollback', () => {
      // 2026-10-25T01:00Z = 2026-10-25 03:00 CEST (before fall-back)
      const now = new Date('2026-10-25T01:00:00Z');
      const scheduledAt = new Date('2026-10-26T01:00:00Z'); // 02:00 CET (next day, after fall-back)
      expect(formatScheduledTimeLabel(scheduledAt, 'Europe/Berlin', now)).toBe(
        'Ngày mai lúc 02:00',
      );
    });
  });
});
