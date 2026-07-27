import { Injectable } from '@nestjs/common';
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

@Injectable()
export class StudyReminderScheduleService {
  constructor(private readonly configService: ConfigService) {}

  getOutboxSettings(): {
    timezone: string;
    minutesBefore: number;
    minLeadMinutes: number;
    syncHorizonHours: number;
    eveningRolloverHour: number;
    stuckProcessingMs: number;
    jobRetentionDays: number;
  } {
    return {
      timezone: this.getTimezone(),
      minutesBefore: this.getMinutesBefore(),
      minLeadMinutes: this.getMinLeadMinutes(),
      syncHorizonHours: this.getSyncHorizonHours(),
      eveningRolloverHour: this.getEveningRolloverHour(),
      stuckProcessingMs: this.getStuckProcessingMs(),
      jobRetentionDays: this.getJobRetentionDays(),
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

  formatScheduledTimeLabel(scheduledAt: Date): string {
    return formatScheduledTimeLabel(scheduledAt, this.getTimezone());
  }

  getMinutesUntilSession(scheduledAt: Date, now: Date = new Date()): number {
    return getMinutesUntilSession(scheduledAt, now);
  }

  isSessionStarted(scheduledAt: Date, now: Date = new Date()): boolean {
    return isSessionStarted(scheduledAt, this.getMinLeadMinutes(), now);
  }

  private getTimezone(): string {
    return (
      this.configService.get<string>('STUDY_REMINDER_TIMEZONE')?.trim() ||
      this.configService.get<string>('CHAT_USAGE_TIMEZONE')?.trim() ||
      DEFAULT_TIMEZONE
    );
  }

  private getMinutesBefore(): number {
    return this.getPositiveNumber(
      'STUDY_REMINDER_MINUTES_BEFORE',
      DEFAULT_MINUTES_BEFORE,
    );
  }

  private getMinLeadMinutes(): number {
    return this.getPositiveNumber(
      'STUDY_REMINDER_MIN_LEAD_MINUTES',
      DEFAULT_MIN_LEAD_MINUTES,
    );
  }

  private getSyncHorizonHours(): number {
    return this.getPositiveNumber(
      'STUDY_REMINDER_SYNC_HORIZON_HOURS',
      DEFAULT_SYNC_HORIZON_HOURS,
    );
  }

  private getEveningRolloverHour(): number {
    return this.getPositiveNumber(
      'STUDY_REMINDER_EVENING_ROLLOVER_HOUR',
      DEFAULT_EVENING_ROLLOVER_HOUR,
    );
  }

  private getStuckProcessingMs(): number {
    return this.getPositiveNumber(
      'STUDY_REMINDER_STUCK_PROCESSING_MS',
      DEFAULT_STUCK_PROCESSING_MS,
    );
  }

  private getJobRetentionDays(): number {
    return this.getPositiveNumber(
      'STUDY_REMINDER_JOB_RETENTION_DAYS',
      DEFAULT_JOB_RETENTION_DAYS,
    );
  }

  private getPositiveNumber(key: string, defaultValue: number): number {
    const raw = this.configService.get<string>(key)?.trim();
    if (!raw) return defaultValue;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : defaultValue;
  }
}
