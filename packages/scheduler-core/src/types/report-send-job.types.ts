import type {
  OutboundDeliveryOutcome,
  ReportSendJobStatus,
} from '@wispace/contracts';

export type { ReportSendJobStatus };

export interface ReportSendJob {
  id: number;
  platform: string;
  externalUserId: string;
  userId?: number;
  examDate: string;
  firstAttemptDate: string;
  status: ReportSendJobStatus;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: Date;
  lastError?: string;
  sentAt?: Date;
  /** Lease owner token — set at claim, required for mark-sent/mark-failed. */
  leaseToken?: string;
  /** Claim deadline — recovery only reopens processing rows past this. */
  leaseExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReportSendJobCreateParams {
  platform: string;
  externalUserId: string;
  userId?: number | null;
  examDate: string;
  firstAttemptDate: string;
  maxRetries: number;
  nextRetryAt: Date;
  errorMessage: string;
}

export interface ReportSendJobUpdateParams {
  jobId: number;
  /** Lease owner token from the claim; omitted for non-claimed terminal writes. */
  leaseToken?: string;
  errorMessage: string;
  retryCount: number;
  nextRetryAt?: Date;
  terminal: boolean;
}

export interface ScheduledReportClaim {
  id: number;
  platform: string;
  externalUserId: string;
  userId?: number;
  reportDate: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReportDeliveryResult {
  ok: boolean;
  reason?: 'WINDOW_CLOSED' | 'DELIVERY_FAILED' | 'RETRYABLE' | 'NOT_LINKED';
  /** Provider delivery verdict used to persist terminal ambiguity. */
  outcome?: OutboundDeliveryOutcome;
}

export interface SendScheduledReportsOptions {
  forceSend?: boolean;
  externalUserId?: string;
  allowDuplicate?: boolean;
}

export interface SendScheduledReportsResult {
  total: number;
  sent: number;
  skipped: number;
  deferred: number;
  windowClosed: number;
  claimSkipped: number;
  retryQueued: number;
  failed: number;
  schedule: {
    minDays: number;
    maxDays: number;
  };
  failures: Array<{ externalUserId: string; error: string }>;
}

export interface ReportMapping {
  id: string | number;
  platform: string;
  externalUserId: string;
  userId?: number;
  notificationCadence?: string;
  status: string;
}

/** Per-batch claim-and-send outcome (Messenger/Discord orchestrations). */
export interface ClaimAndSendResult {
  sent: number;
  skipped: number;
  deferred: number;
  windowClosed: number;
  claimSkipped: number;
  retryQueued: number;
  failures: Array<{ externalUserId: string; error: string }>;
}
