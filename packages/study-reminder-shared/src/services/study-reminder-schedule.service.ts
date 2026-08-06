import {
  Injectable,
  InternalServerErrorException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  computeRemindAt,
  formatScheduledTimeLabel,
  getMinutesUntilSession,
  isSessionStarted,
} from '@wispace/study-reminder-core';

const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';
const DEFAULT_MINUTES_BEFORE = 30;
const DEFAULT_MIN_LEAD_MINUTES = 5;
const DEFAULT_POLL_MIN_MS = 30_000;
const DEFAULT_POLL_MAX_MS = 210_000;
const DEFAULT_POLL_LEAD_MS = 60_000;
const DEFAULT_STUCK_PROCESSING_MS = 600_000;
const DEFAULT_JOB_RETENTION_DAYS = 7;
const DEFAULT_SYNC_HORIZON_HOURS = 48;
const DEFAULT_EVENING_ROLLOVER_HOUR = 23;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_MINUTES = 2;

export interface StudyReminderScheduleServiceOptions {
  /**
   * Messenger mode: missing/invalid required `STUDY_REMINDER_*` vars throw
   * instead of silently defaulting (AGENTS.md: they are required in .env).
   */
  strict?: boolean;
  /**
   * Env keys checked in order for the timezone (Messenger prefers
   * `CHAT_USAGE_TIMEZONE` → `LLM_USAGE_TIMEZONE` → `STUDY_REMINDER_TIMEZONE`).
   */
  timezoneEnvKeys?: string[];
}

@Injectable()
export class StudyReminderScheduleService {
  constructor(
    private readonly configService: ConfigService,
    @Optional()
    private readonly options: StudyReminderScheduleServiceOptions = {},
  ) {}

  getOutboxSettings(): {
    timezone: string;
    minutesBefore: number;
    minLeadMinutes: number;
    syncHorizonHours: number;
    eveningRolloverHour: number;
    stuckProcessingMs: number;
    jobRetentionDays: number;
    maxRetries: number;
    retryBackoffMinutes: number;
  } {
    return {
      timezone: this.getTimezone(),
      minutesBefore: this.getMinutesBefore(),
      minLeadMinutes: this.getMinLeadMinutes(),
      syncHorizonHours: this.getSyncHorizonHours(),
      eveningRolloverHour: this.getEveningRolloverHour(),
      stuckProcessingMs: this.getStuckProcessingMs(),
      jobRetentionDays: this.getJobRetentionDays(),
      maxRetries: this.getMaxRetries(),
      retryBackoffMinutes: this.getRetryBackoffMinutes(),
    };
  }

  getDispatchSettings(): {
    pollMinMs: number;
    pollMaxMs: number;
    pollLeadMs: number;
  } {
    return {
      pollMinMs: this.getPositiveNumber(
        'STUDY_REMINDER_POLL_MIN_MS',
        DEFAULT_POLL_MIN_MS,
      ),
      pollMaxMs: this.getPositiveNumber(
        'STUDY_REMINDER_POLL_MAX_MS',
        DEFAULT_POLL_MAX_MS,
      ),
      pollLeadMs: this.getPositiveNumber(
        'STUDY_REMINDER_POLL_LEAD_MS',
        DEFAULT_POLL_LEAD_MS,
      ),
    };
  }

  computeRemindAt(scheduledAt: Date): Date {
    return computeRemindAt(scheduledAt, this.getMinutesBefore());
  }

  formatScheduledTimeLabel(scheduledAt: Date, now: Date = new Date()): string {
    return formatScheduledTimeLabel(scheduledAt, this.getTimezone(), now);
  }

  getMinutesUntilSession(scheduledAt: Date, now: Date = new Date()): number {
    return getMinutesUntilSession(scheduledAt, now);
  }

  isSessionStarted(scheduledAt: Date, now: Date = new Date()): boolean {
    return isSessionStarted(scheduledAt, this.getMinLeadMinutes(), now);
  }

  private getTimezone(): string {
    const keys = this.options.timezoneEnvKeys ?? [
      'STUDY_REMINDER_TIMEZONE',
      'CHAT_USAGE_TIMEZONE',
    ];
    for (const key of keys) {
      const value = this.configService.get<string>(key)?.trim();
      if (value) return value;
    }
    return DEFAULT_TIMEZONE;
  }

  private getMinutesBefore(): number {
    return this.getNumber(
      'STUDY_REMINDER_MINUTES_BEFORE',
      DEFAULT_MINUTES_BEFORE,
    );
  }

  private getMinLeadMinutes(): number {
    return this.getNumber(
      'STUDY_REMINDER_MIN_LEAD_MINUTES',
      DEFAULT_MIN_LEAD_MINUTES,
    );
  }

  private getSyncHorizonHours(): number {
    return this.getNumber(
      'STUDY_REMINDER_SYNC_HORIZON_HOURS',
      DEFAULT_SYNC_HORIZON_HOURS,
    );
  }

  private getMaxRetries(): number {
    return this.getNumber('STUDY_REMINDER_MAX_RETRIES', DEFAULT_MAX_RETRIES);
  }

  private getRetryBackoffMinutes(): number {
    return this.getNumber(
      'STUDY_REMINDER_RETRY_BACKOFF_MINUTES',
      DEFAULT_RETRY_BACKOFF_MINUTES,
    );
  }

  private getJobRetentionDays(): number {
    return this.getNumber(
      'STUDY_REMINDER_JOB_RETENTION_DAYS',
      DEFAULT_JOB_RETENTION_DAYS,
    );
  }

  private getEveningRolloverHour(): number {
    const raw = this.configService
      .get<string>('STUDY_REMINDER_EVENING_ROLLOVER_HOUR')
      ?.trim();
    if (!raw) {
      return DEFAULT_EVENING_ROLLOVER_HOUR;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 23) {
      if (this.options.strict) {
        throw new InternalServerErrorException(
          'STUDY_REMINDER_EVENING_ROLLOVER_HOUR must be an integer from 0 to 23 in .env',
        );
      }
      return DEFAULT_EVENING_ROLLOVER_HOUR;
    }
    return value;
  }

  private getStuckProcessingMs(): number {
    return this.getNumber(
      'STUDY_REMINDER_STUCK_PROCESSING_MS',
      DEFAULT_STUCK_PROCESSING_MS,
      'default',
      'throw',
    );
  }

  private getPositiveNumber(key: string, defaultValue: number): number {
    return this.getNumber(key, defaultValue, 'default', 'default');
  }

  /**
   * In strict mode a 'throw' behavior raises when the var is missing/invalid;
   * 'default' falls back silently. In non-strict mode everything falls back.
   */
  private getNumber(
    key: string,
    defaultValue: number,
    missing: 'default' | 'throw' = 'throw',
    invalid: 'default' | 'throw' = 'throw',
  ): number {
    const raw = this.configService.get<string>(key)?.trim();
    if (!raw) {
      if (this.options.strict && missing === 'throw') {
        throw new InternalServerErrorException(`${key} must be set in .env`);
      }
      return defaultValue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      if (this.options.strict && invalid === 'throw') {
        throw new InternalServerErrorException(
          `${key} must be a positive number in .env`,
        );
      }
      return defaultValue;
    }
    return value;
  }
}
