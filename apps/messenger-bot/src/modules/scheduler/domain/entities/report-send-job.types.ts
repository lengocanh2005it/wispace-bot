import type { ReportSendJobStatus } from '@messenger/infrastructure/database/entities/report-send-job.entity';

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
