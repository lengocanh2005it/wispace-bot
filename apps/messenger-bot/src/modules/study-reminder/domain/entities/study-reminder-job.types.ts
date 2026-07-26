export type StudyReminderJobStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'cancelled';

export interface StudyReminderJob {
  id: number;
  psid: string;
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
  psid: string;
  userId?: number;
  sessionKey: string;
  scheduledAt: Date;
  remindAt: Date;
  topic?: string;
  maxRetries: number;
}
