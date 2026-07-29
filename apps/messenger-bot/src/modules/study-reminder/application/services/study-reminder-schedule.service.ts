import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  computeRemindAt,
  formatScheduledTimeLabel,
  getMinutesUntilSession,
  isSessionStarted,
} from '@wispace/study-reminder-core';
import { resolveAppTimezone } from '@messenger/shared/config/app-timezone';
import {
  readOptionalPositiveNumber,
  readRequiredPositiveNumber,
} from '@messenger/shared/config/env-helpers';

@Injectable()
export class StudyReminderScheduleService {
  constructor(private readonly configService: ConfigService) {}

  getOutboxSettings(): {
    minutesBefore: number;
    minLeadMinutes: number;
    syncHorizonHours: number;
    maxRetries: number;
    retryBackoffMinutes: number;
    jobRetentionDays: number;
    eveningRolloverHour: number;
    timezone: string;
    stuckProcessingMs: number;
  } {
    return {
      minutesBefore: this.getMinutesBefore(),
      minLeadMinutes: this.getMinLeadMinutes(),
      syncHorizonHours: this.getSyncHorizonHours(),
      maxRetries: this.getMaxRetries(),
      retryBackoffMinutes: this.getRetryBackoffMinutes(),
      jobRetentionDays: this.getJobRetentionDays(),
      eveningRolloverHour: this.getEveningRolloverHour(),
      timezone: this.getTimezone(),
      stuckProcessingMs: this.getStuckProcessingMs(),
    };
  }

  computeRemindAt(scheduledAt: Date): Date {
    return computeRemindAt(scheduledAt, this.getMinutesBefore());
  }

  getMinutesUntilSession(scheduledAt: Date, now = new Date()): number {
    return getMinutesUntilSession(scheduledAt, now);
  }

  isSessionStarted(scheduledAt: Date, now = new Date()): boolean {
    return isSessionStarted(scheduledAt, this.getMinLeadMinutes(), now);
  }

  formatScheduledTimeLabel(scheduledAt: Date, now = new Date()): string {
    return formatScheduledTimeLabel(scheduledAt, this.getTimezone(), now);
  }

  private getMinutesBefore(): number {
    return readRequiredPositiveNumber(
      this.configService,
      'STUDY_REMINDER_MINUTES_BEFORE',
    );
  }

  private getMinLeadMinutes(): number {
    return readRequiredPositiveNumber(
      this.configService,
      'STUDY_REMINDER_MIN_LEAD_MINUTES',
    );
  }

  private getSyncHorizonHours(): number {
    return readRequiredPositiveNumber(
      this.configService,
      'STUDY_REMINDER_SYNC_HORIZON_HOURS',
    );
  }

  private getMaxRetries(): number {
    return readRequiredPositiveNumber(
      this.configService,
      'STUDY_REMINDER_MAX_RETRIES',
    );
  }

  private getRetryBackoffMinutes(): number {
    return readRequiredPositiveNumber(
      this.configService,
      'STUDY_REMINDER_RETRY_BACKOFF_MINUTES',
    );
  }

  private getJobRetentionDays(): number {
    return readRequiredPositiveNumber(
      this.configService,
      'STUDY_REMINDER_JOB_RETENTION_DAYS',
    );
  }

  private getEveningRolloverHour(): number {
    const raw = this.configService
      .get<string>('STUDY_REMINDER_EVENING_ROLLOVER_HOUR')
      ?.trim();

    if (!raw) {
      return 23;
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 23) {
      throw new InternalServerErrorException(
        'STUDY_REMINDER_EVENING_ROLLOVER_HOUR must be an integer from 0 to 23 in .env',
      );
    }

    return value;
  }

  private getTimezone(): string {
    return resolveAppTimezone(this.configService);
  }

  private getStuckProcessingMs(): number {
    return readOptionalPositiveNumber(
      this.configService,
      'STUDY_REMINDER_STUCK_PROCESSING_MS',
      10 * 60 * 1000,
    );
  }
}
