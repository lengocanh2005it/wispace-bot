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
});
