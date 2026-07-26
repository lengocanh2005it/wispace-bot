export type CalendarSessionTimeRange = 'upcoming' | 'past' | 'all';

export interface StudySessionView {
  sessionKey: string;
  scheduledAt: Date;
  topic: string;
  durationMinutes?: number;
}

export interface StudyCalendarEntryView {
  calendarId: number;
  eventDate: string;
  time: string | null;
  scheduledTimeLabel: string;
  topic: string;
}

export interface StudyReminderLlmOutput {
  greeting: string;
  intro: string;
  scheduledTime: string;
  tasks: string[];
  motivation: string;
  signoff: string;
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
