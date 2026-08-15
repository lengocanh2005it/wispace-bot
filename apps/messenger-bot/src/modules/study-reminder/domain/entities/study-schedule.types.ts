import type {
  CalendarSessionTimeRange,
  NormalizedStudySession,
} from '@wispace/wispace-client';

export type { CalendarSessionTimeRange, NormalizedStudySession };

export interface StudySessionRecord {
  id?: string | number;
  sessionId?: string | number;
  scheduledAt?: string;
  scheduled_at?: string;
  startTime?: string;
  start_time?: string;
  dateTime?: string;
  topic?: string;
  subject?: string;
  title?: string;
  durationMinutes?: number;
  duration_minutes?: number;
  status?: string;
}

export interface StudyReminderLlmInput {
  displayName: string;
  scheduledAtIso: string;
  scheduledTimeLabel: string;
  topic: string;
  targetScore?: number;
  task1Band?: number;
  task2Band?: number;
  minutesUntil: number;
}

export interface StudyReminderLlmOutput {
  greeting: string;
  intro: string;
  scheduledTime: string;
  tasks: string[];
  motivation: string;
  signoff: string;
}

/**
 * LLM-written fields of a reminder. `scheduledTime` is deliberately NOT part
 * of the model contract — it is always rendered from trusted server data
 * (`scheduledTimeLabel`), so a hallucinated/injected time can never reach the
 * user (issue #123).
 */
export type StudyReminderLlmProse = Omit<
  StudyReminderLlmOutput,
  'scheduledTime'
>;
