import { StudyReminderJob } from '../entities/study-reminder-job.types';

export const STUDY_REMINDER_JOB_REPOSITORY = Symbol(
  'STUDY_REMINDER_JOB_REPOSITORY',
);

export interface StudyReminderJobRepositoryPort {
  upsertPendingJob(params: {
    platform: string;
    psid: string;
    userId?: number;
    sessionKey: string;
    scheduledAt: Date;
    remindAt: Date;
    topic?: string;
    maxRetries: number;
  }): Promise<StudyReminderJob>;

  cancelStaleJobsForPsid(
    psid: string,
    activeSessionKeys: string[],
    horizonEnd: Date,
    platform: string,
  ): Promise<number>;

  findDueJobs(now: Date, minLeadMinutes: number): Promise<StudyReminderJob[]>;

  claimJob(jobId: number): Promise<StudyReminderJob | null>;

  markSent(jobId: number): Promise<void>;

  markCancelled(jobId: number, reason: string): Promise<void>;

  markFailed(params: {
    jobId: number;
    errorMessage: string;
    retryCount: number;
    nextRetryAt?: Date;
    terminal: boolean;
  }): Promise<void>;

  resetStuckProcessingJobs(cutoff: Date): Promise<number>;

  /** Returns the soonest time any pending/retryable job becomes actionable (after `after`). */
  findNextDueTime(after: Date): Promise<Date | null>;

  deleteSentJobs(): Promise<number>;

  deleteTerminalJobsOlderThan(cutoff: Date): Promise<number>;

  countJobsByStatus(): Promise<Record<string, number>>;

  countTerminalFailedSince(since: Date): Promise<number>;

  countStuckProcessing(olderThan: Date): Promise<number>;

  findTerminalFailedSince(
    since: Date,
    limit: number,
  ): Promise<StudyReminderJob[]>;

  findStuckProcessing(
    olderThan: Date,
    limit: number,
  ): Promise<StudyReminderJob[]>;

  cancelJobsFromOtherPlatforms(
    userId: number,
    currentPlatform: string,
  ): Promise<number>;
}
