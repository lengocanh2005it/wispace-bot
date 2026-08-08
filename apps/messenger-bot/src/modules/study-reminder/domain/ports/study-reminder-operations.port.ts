import type {
  CalendarSessionTimeRange,
  NormalizedStudySession,
  RescheduleSchedulingMode,
} from '@wispace/wispace-client';
import type { StudyCalendarEntryView } from '@wispace/reschedule-confirm';
import type { StudyReminderLlmOutput } from '../entities/study-schedule.types';

export type {
  CalendarSessionTimeRange,
  NormalizedStudySession,
} from '@wispace/wispace-client';

export const STUDY_REMINDER_OPERATIONS_PORT = Symbol(
  'STUDY_REMINDER_OPERATIONS_PORT',
);

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

export interface StudyReminderOperationsPort {
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
    },
  ): Promise<{
    timeRange: CalendarSessionTimeRange;
    entries: StudyCalendarEntryView[];
  }>;

  getOutboxSettings(): StudyOutboxSettings;

  formatScheduledTimeLabel(scheduledAt: Date, now?: Date): string;

  rescheduleSession(params: {
    psid: string;
    userId: number;
    calendarId: number;
    schedulingMode: RescheduleSchedulingMode;
    newLocalDate?: string;
    newTime?: string;
  }): Promise<{ scheduledTimeLabel: string }>;
}
