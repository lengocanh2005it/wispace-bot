import type {
  ReportSendJob,
  ReportSendJobCreateParams,
  ReportSendJobUpdateParams,
} from '../types/report-send-job.types';

export const REPORT_SEND_JOB_REPOSITORY = Symbol('REPORT_SEND_JOB_REPOSITORY');

export interface ReportSendJobRepositoryPort {
  recordRetryableFailure(
    params: ReportSendJobCreateParams,
  ): Promise<ReportSendJob>;
  findDueJobs(now: Date, limit?: number): Promise<ReportSendJob[]>;
  /**
   * Claims the job for this worker: assigns a fresh lease token and expiry.
   * @param leaseMs how long the claim stays valid (heartbeat-free lease).
   */
  claimJob(jobId: number, leaseMs: number): Promise<ReportSendJob | null>;
  /** Marks sent — requires the current lease token (stale owners no-op). */
  markSent(jobId: number, leaseToken: string): Promise<void>;
  markFailed(params: ReportSendJobUpdateParams): Promise<void>;
  markSentByExternalUserExamDate(
    externalUserId: string,
    examDate: string,
  ): Promise<void>;
  resetStuckProcessingJobs(olderThan: Date): Promise<number>;
  countTerminalFailedSince(since: Date): Promise<number>;
}
