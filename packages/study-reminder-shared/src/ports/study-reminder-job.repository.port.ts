import type {
  StudyReminderJob,
  StudyReminderJobStatus,
  UpsertStudyReminderJobInput,
} from '../types/study-reminder.types';

export type {
  StudyReminderJob,
  UpsertStudyReminderJobInput,
  StudyReminderJobStatus,
};

export const STUDY_REMINDER_JOB_REPOSITORY = Symbol(
  'STUDY_REMINDER_JOB_REPOSITORY',
);

export interface UpsertStudyReminderJobOptions {
  /**
   * When set, the upsert runs inside a transaction holding
   * `pg_advisory_xact_lock(hashtext(lockKey))` — serializes concurrent
   * syncs of the same (platform, externalUserId, sessionKey) on multi-pod
   * deployments (Messenger passes `srj:{psid}:{sessionKey}`).
   */
  lockKey?: string;
  /**
   * Messenger semantics: `sent`/`processing` jobs are reopened to `pending`
   * only when the schedule (scheduledAt/remindAt/topic) changed; `cancelled`
   * jobs are always reopened. Off (default): `sent` is kept as-is,
   * `cancelled`/`processing` are force-reopened.
   */
  reopenOnlyOnScheduleChange?: boolean;
}

export interface StudyReminderJobRepositoryPort {
  upsertPendingJob(
    input: UpsertStudyReminderJobInput,
    options?: UpsertStudyReminderJobOptions,
  ): Promise<StudyReminderJob>;
  findDueJobs(now: Date, minLeadMinutes: number): Promise<StudyReminderJob[]>;
  claimJob(jobId: number): Promise<StudyReminderJob | null>;
  markSent(jobId: number): Promise<void>;
  markFailed(params: {
    jobId: number;
    errorMessage: string;
    retryCount: number;
    nextRetryAt?: Date;
    terminal: boolean;
  }): Promise<void>;
  markCancelled(jobId: number, reason?: string): Promise<void>;
  cancelStaleJobsForExternalUserId(
    platform: string,
    externalUserId: string,
    activeSessionKeys: string[],
    horizonEnd?: Date,
    options?: { statuses?: StudyReminderJobStatus[] },
  ): Promise<number>;
  cancelJobsFromOtherPlatforms(
    userId: number,
    currentPlatform: string,
    options?: { statuses?: StudyReminderJobStatus[] },
  ): Promise<number>;
  findNextDueTime(now: Date): Promise<Date | null>;
  /**
   * Resets jobs stuck in `processing` — target status defaults to `failed`
   * (Discord/Zalo); Messenger passes `pending` so stuck jobs retry the same day.
   */
  resetStuckProcessingJobs(
    olderThan: Date,
    targetStatus?: 'pending' | 'failed',
  ): Promise<number>;
  /** Deletes all `sent` jobs when no cutoff is given (Messenger rollover). */
  deleteSentJobs(olderThan?: Date): Promise<number>;
  deleteTerminalJobsOlderThan(olderThan: Date): Promise<number>;
  /** Counts by status; no platform filter when omitted (Messenger ops-health). */
  countJobsByStatus(platform?: string): Promise<Record<string, number>>;
  countTerminalFailedSince(since: Date): Promise<number>;
  countStuckProcessing(olderThan: Date): Promise<number>;
  findTerminalFailedSince(
    since: Date,
    limit: number,
  ): Promise<StudyReminderJob[]>;
  findStuckProcessing(
    olderThan: Date,
    limit?: number,
  ): Promise<StudyReminderJob[]>;
}
