import type {
  CalendarSessionTimeRange,
  NormalizedStudySession,
} from '@wispace/wispace-client';
import type { StudyCalendarEntryView } from '@wispace/reschedule-confirm';
import type { StudyReminderLlmOutput } from '@messenger/modules/study-reminder/domain/entities/study-schedule.types';

export type {
  CalendarSessionTimeRange,
  NormalizedStudySession,
} from '@wispace/wispace-client';

export type StudySessionView = NormalizedStudySession;

export type { StudyCalendarEntryView, StudyReminderLlmOutput };

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

export const STUDY_DATA_PORT = Symbol('STUDY_DATA_PORT');

export interface StudyDataPort {
  getUpcomingSessions(params: {
    psid: string;
    userId?: number;
    horizonEnd?: Date;
  }): Promise<StudySessionView[]>;

  getNextUpcomingSession(
    psid: string,
    userId?: number,
  ): Promise<StudySessionView | null>;

  generateReminderBundleForSession(
    psid: string,
    session: StudySessionView,
    options?: { userId?: number; displayName?: string; jobId?: number },
  ): Promise<{ text: string; output: StudyReminderLlmOutput }>;

  listCalendarEntries(
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
}
