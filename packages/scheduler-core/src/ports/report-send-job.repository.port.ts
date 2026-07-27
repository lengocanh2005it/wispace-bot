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
  claimJob(jobId: number): Promise<ReportSendJob | null>;
  markSent(jobId: number): Promise<void>;
  markFailed(params: ReportSendJobUpdateParams): Promise<void>;
  markSentByExternalUserExamDate(
    externalUserId: string,
    examDate: string,
  ): Promise<void>;
  resetStuckProcessingJobs(olderThan: Date): Promise<number>;
  countTerminalFailedSince(since: Date): Promise<number>;
}
