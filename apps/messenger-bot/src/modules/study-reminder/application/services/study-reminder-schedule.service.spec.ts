import { ConfigService } from '@nestjs/config';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';

describe('StudyReminderScheduleService', () => {
  const config = {
    get: (key: string) => {
      const values: Record<string, string> = {
        STUDY_REMINDER_MINUTES_BEFORE: '30',
        STUDY_REMINDER_MIN_LEAD_MINUTES: '1',
        STUDY_REMINDER_SYNC_HORIZON_HOURS: '336',
        STUDY_REMINDER_MAX_RETRIES: '3',
        STUDY_REMINDER_RETRY_BACKOFF_MINUTES: '2',
        STUDY_REMINDER_JOB_RETENTION_DAYS: '7',
        CHAT_USAGE_TIMEZONE: 'Asia/Ho_Chi_Minh',
      };
      return values[key];
    },
  } as ConfigService;

  const service = new StudyReminderScheduleService(config);

  it('computes remind_at 30 minutes before session start', () => {
    const scheduledAt = new Date('2026-06-09T10:30:00+07:00');
    const remindAt = service.computeRemindAt(scheduledAt);

    expect(remindAt.toISOString()).toBe(
      new Date(scheduledAt.getTime() - 30 * 60 * 1000).toISOString(),
    );
  });

  it('detects when a session has already started', () => {
    const scheduledAt = new Date('2026-06-09T10:30:00+07:00');
    const now = new Date('2026-06-09T10:31:00+07:00');

    expect(service.isSessionStarted(scheduledAt, now)).toBe(true);
  });

  it('does not treat a future session as started', () => {
    const scheduledAt = new Date('2026-06-09T10:30:00+07:00');
    const now = new Date('2026-06-09T10:00:00+07:00');

    expect(service.isSessionStarted(scheduledAt, now)).toBe(false);
  });

  it('defaults evening rollover hour to 23', () => {
    expect(service.getOutboxSettings().eveningRolloverHour).toBe(23);
  });

  it('labels a session on the next local calendar day as tomorrow', () => {
    const scheduledAt = new Date('2026-06-15T08:00:00+07:00');
    const now = new Date('2026-06-14T23:30:00+07:00');

    expect(service.formatScheduledTimeLabel(scheduledAt, now)).toBe(
      'Ngày mai lúc 08:00',
    );
  });
});
