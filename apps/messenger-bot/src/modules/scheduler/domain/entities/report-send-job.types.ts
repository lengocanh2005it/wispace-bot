import type { ReportSendJobStatus } from '@wispace/database';

export interface ReportSendJob {
  id: number;
  psid: string;
  userId?: number;
  examDate: string;
  firstAttemptDate: string;
  status: ReportSendJobStatus;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: Date;
  lastError?: string;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
