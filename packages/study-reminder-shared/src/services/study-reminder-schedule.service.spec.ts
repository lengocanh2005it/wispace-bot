import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';

function makeConfig(values: Record<string, string>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as ConfigService;
}

describe('StudyReminderScheduleService', () => {
  it('computes remind_at minutes before session start', () => {
    const service = new StudyReminderScheduleService(
      makeConfig({ STUDY_REMINDER_MINUTES_BEFORE: '30' }),
    );
    const scheduledAt = new Date('2026-06-09T10:30:00+07:00');

    expect(service.computeRemindAt(scheduledAt)).toEqual(
      new Date(scheduledAt.getTime() - 30 * 60 * 1000),
    );
  });

  it('labels a session on the next local calendar day as tomorrow', () => {
    const service = new StudyReminderScheduleService(
      makeConfig({ CHAT_USAGE_TIMEZONE: 'Asia/Ho_Chi_Minh' }),
    );
    const scheduledAt = new Date('2026-06-15T08:00:00+07:00');
    const now = new Date('2026-06-14T23:30:00+07:00');

    expect(service.formatScheduledTimeLabel(scheduledAt, now)).toBe(
      'Ngày mai lúc 08:00',
    );
  });

  it('defaults evening rollover hour to 23 when unset', () => {
    const service = new StudyReminderScheduleService(makeConfig({}));

    expect(service.getOutboxSettings().eveningRolloverHour).toBe(23);
  });

  describe('strict mode (Messenger)', () => {
    it('throws on missing required STUDY_REMINDER_* vars', () => {
      const service = new StudyReminderScheduleService(makeConfig({}), {
        strict: true,
      });

      expect(() => service.getOutboxSettings()).toThrow(
        InternalServerErrorException,
      );
    });

    it('throws on invalid evening rollover hour', () => {
      const service = new StudyReminderScheduleService(
        makeConfig({
          STUDY_REMINDER_MINUTES_BEFORE: '30',
          STUDY_REMINDER_MIN_LEAD_MINUTES: '5',
          STUDY_REMINDER_SYNC_HORIZON_HOURS: '48',
          STUDY_REMINDER_MAX_RETRIES: '3',
          STUDY_REMINDER_RETRY_BACKOFF_MINUTES: '2',
          STUDY_REMINDER_JOB_RETENTION_DAYS: '7',
          STUDY_REMINDER_EVENING_ROLLOVER_HOUR: '99',
        }),
        { strict: true },
      );

      expect(() => service.getOutboxSettings()).toThrow(
        'STUDY_REMINDER_EVENING_ROLLOVER_HOUR must be an integer from 0 to 23',
      );
    });

    it('returns settings when all required vars are present', () => {
      const service = new StudyReminderScheduleService(
        makeConfig({
          STUDY_REMINDER_MINUTES_BEFORE: '30',
          STUDY_REMINDER_MIN_LEAD_MINUTES: '5',
          STUDY_REMINDER_SYNC_HORIZON_HOURS: '336',
          STUDY_REMINDER_MAX_RETRIES: '3',
          STUDY_REMINDER_RETRY_BACKOFF_MINUTES: '2',
          STUDY_REMINDER_JOB_RETENTION_DAYS: '7',
          STUDY_REMINDER_EVENING_ROLLOVER_HOUR: '22',
          CHAT_USAGE_TIMEZONE: 'Asia/Ho_Chi_Minh',
        }),
        { strict: true },
      );

      const settings = service.getOutboxSettings();

      expect(settings).toMatchObject({
        minutesBefore: 30,
        minLeadMinutes: 5,
        syncHorizonHours: 336,
        maxRetries: 3,
        retryBackoffMinutes: 2,
        jobRetentionDays: 7,
        eveningRolloverHour: 22,
        timezone: 'Asia/Ho_Chi_Minh',
      });
    });

    it('respects custom timezone env key order (LLM_USAGE_TIMEZONE alias)', () => {
      const service = new StudyReminderScheduleService(
        makeConfig({
          STUDY_REMINDER_MINUTES_BEFORE: '30',
          STUDY_REMINDER_MIN_LEAD_MINUTES: '5',
          STUDY_REMINDER_SYNC_HORIZON_HOURS: '48',
          STUDY_REMINDER_MAX_RETRIES: '3',
          STUDY_REMINDER_RETRY_BACKOFF_MINUTES: '2',
          STUDY_REMINDER_JOB_RETENTION_DAYS: '7',
          LLM_USAGE_TIMEZONE: 'Asia/Bangkok',
          CHAT_USAGE_TIMEZONE: 'Asia/Ho_Chi_Minh',
        }),
        {
          strict: true,
          timezoneEnvKeys: [
            'CHAT_USAGE_TIMEZONE',
            'LLM_USAGE_TIMEZONE',
            'STUDY_REMINDER_TIMEZONE',
          ],
        },
      );

      expect(service.getOutboxSettings().timezone).toBe('Asia/Ho_Chi_Minh');
    });
  });

  describe('non-strict mode (Discord/Zalo)', () => {
    it('silently defaults when vars are missing', () => {
      const service = new StudyReminderScheduleService(makeConfig({}));

      expect(service.getOutboxSettings()).toMatchObject({
        minutesBefore: 30,
        minLeadMinutes: 5,
        syncHorizonHours: 48,
        maxRetries: 3,
        retryBackoffMinutes: 2,
        jobRetentionDays: 7,
        stuckProcessingMs: 600_000,
        timezone: 'Asia/Ho_Chi_Minh',
      });
    });
  });
});
