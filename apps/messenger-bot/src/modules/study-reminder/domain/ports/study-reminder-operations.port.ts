import type {
  CalendarSessionTimeRange,
  NormalizedStudySession,
  RescheduleSchedulingMode,
} from '@wispace/wispace-client/core';
import type { StudyCalendarEntryView } from '@wispace/reschedule-confirm/core';
import type { StudyReminderLlmOutput } from '../entities/study-schedule.types';

export type {
  CalendarSessionTimeRange,
  NormalizedStudySession,
} from '@wispace/wispace-client/core';

export const STUDY_REMINDER_OPERATIONS_PORT = Symbol(
  'STUDY_REMINDER_OPERATIONS_PORT',
);
export const STUDY_REMINDER_TIME_FORMATTER = Symbol(
  'STUDY_REMINDER_TIME_FORMATTER',
);

export interface StudyReminderTimeFormatterPort {
  formatScheduledTimeLabel(scheduledAt: Date, now?: Date): string;
}

export interface StudyOutboxSettings {
  minutesBefore: number;
  minLeadMinutes: number;
  syncHorizonHours: number;
  maxRetries: number;
  retryBackoffMinutes: number;
  jobRetentionDays: number;
  eveningRolloverHour: number;
  timezone: string;
  stuckProcessingMs: number;
}

export interface StudyReminderOperationsPort extends StudyReminderTimeFormatterPort {
  getUpcomingSessions(params: {
    psid: string;
    userId?: number;
    horizonEnd?: Date;
  }): Promise<NormalizedStudySession[]>;

  getNextUpcomingSession(
    psid: string,
    userId?: number,
  ): Promise<NormalizedStudySession | null>;

  generateReminderBundleForSession(
    psid: string,
    session: NormalizedStudySession,
    options?: { userId?: number; displayName?: string; jobId?: number },
  ): Promise<{ text: string; output: StudyReminderLlmOutput }>;

  listEntries(
    psid: string,
    userId?: number,
    options?: {
      timeRange?: CalendarSessionTimeRange;
      limit?: number;
      pastDays?: number;
      signal?: AbortSignal;
    },
  ): Promise<{
    timeRange: CalendarSessionTimeRange;
    entries: StudyCalendarEntryView[];
  }>;

  getOutboxSettings(): StudyOutboxSettings;

  rescheduleSession(params: {
    psid: string;
    userId: number;
    calendarId: number;
    schedulingMode: RescheduleSchedulingMode;
    newLocalDate?: string;
    newTime?: string;
  }): Promise<{ scheduledTimeLabel: string }>;
}
