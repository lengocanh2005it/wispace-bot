export type StudyReminderJobStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'cancelled';

export interface StudyReminderJob {
  id: number;
  platform: string;
  externalUserId: string;
  userId?: number;
  sessionKey: string;
  scheduledAt: Date;
  remindAt: Date;
  topic?: string;
  status: StudyReminderJobStatus;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: Date;
  lastError?: string;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertStudyReminderJobInput {
  platform: string;
  externalUserId: string;
  userId?: number;
  sessionKey: string;
  scheduledAt: Date;
  remindAt: Date;
  topic?: string;
  maxRetries: number;
}

export type GetSessionsFn = (
  externalUserId: string,
  userId?: number,
) => Promise<StudySessionRecord[]>;

export interface StudySessionRecord {
  calendarId: string;
  sessionKey: string;
  scheduledAt: Date;
  topic?: string;
}

export interface StudyReminderLlmInput {
  displayName: string;
  topic: string;
  scheduledTimeLabel: string;
  minutesUntilSession: number;
  targetScore?: string;
  task1Band?: string;
  task2Band?: string;
}

export interface StudyReminderLlmOutput {
  greeting: string;
  intro: string;
  scheduledTime: string;
  tasks: string[];
  motivation: string;
  signoff: string;
}

export interface UserLink {
  externalUserId: string;
  userId?: number;
  platform: string;
}

export interface SendMessageInput {
  externalUserId: string;
  text: string;
  messageType?: string;
  userId?: number;
}

export interface StudyReminderSyncFailure {
  externalUserId: string;
  error: string;
}

/**
 * Result of a sync run. Counters are always present; `scope`/`userId`/
 * `linked`/`cancelledOtherPlatforms`/`failures` are populated by every run
 * (Messenger consumes the full shape — see scheduler.controller).
 */
export interface StudyReminderSyncResult {
  mappings: number;
  upserted: number;
  cancelled: number;
  skipped: number;
  failed: number;
  scope?: 'all' | 'user';
  userId?: number;
  linked?: boolean;
  cancelledOtherPlatforms?: number;
  failures?: StudyReminderSyncFailure[];
}
