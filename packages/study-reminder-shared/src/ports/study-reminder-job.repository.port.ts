import type {
  StudyReminderJob,
  StudyReminderJobStatus,
  UpsertStudyReminderJobInput,
} from '../types/study-reminder.types';
import type { OutboundDeliveryOutcome, Platform } from '@wispace/contracts';

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
   * Production sync semantics: `sent`/`processing`/terminal-outcome jobs are
   * reopened only when the schedule (scheduledAt/remindAt/topic) changed;
   * `cancelled` jobs are always reopened. Pending/failed retryable jobs keep
   * their retry state on an unchanged schedule.
   */
  reopenOnlyOnScheduleChange?: boolean;
}

export interface StudyReminderJobRepositoryPort {
  upsertPendingJob(
    input: UpsertStudyReminderJobInput,
    options?: UpsertStudyReminderJobOptions,
  ): Promise<StudyReminderJob>;
  /**
   * Batch upsert — transaction-scoped locks protect the snapshot while
   * applying the same per-row semantics as `upsertPendingJob`.
   */
  upsertPendingJobs(
    inputs: UpsertStudyReminderJobInput[],
    options?: UpsertStudyReminderJobOptions,
  ): Promise<StudyReminderJob[]>;
  /**
   * Jobs due for THIS platform only — a worker must never see another
   * platform's jobs (it would send them through the wrong transport, #180).
   */
  findDueJobs(
    platform: Platform,
    now: Date,
    minLeadMinutes: number,
  ): Promise<StudyReminderJob[]>;
  /**
   * Claims the job for this worker: assigns a fresh lease token and expiry.
   * @param platform the claiming worker's platform — claims are scoped to it.
   * @param leaseMs how long the claim stays valid (heartbeat-free lease).
   */
  claimJob(
    platform: Platform,
    jobId: number,
    leaseMs: number,
  ): Promise<StudyReminderJob | null>;
  /** Marks sent — requires the current lease token; false means stale owner. */
  markSent(
    jobId: number,
    leaseToken: string,
    deliveryRecord?: string,
    deliveryKey?: string,
  ): Promise<boolean>;
  /** Persists a stable delivery key; false means the lease was lost (#294). */
  markDeliveryKey(
    jobId: number,
    leaseToken: string,
    deliveryKey: string,
  ): Promise<boolean>;
  markFailed(params: {
    jobId: number;
    leaseToken: string;
    errorMessage: string;
    retryCount: number;
    nextRetryAt?: Date;
    terminal: boolean;
    deliveryStatus: OutboundDeliveryOutcome;
  }): Promise<void>;
  /** Marks cancelled — requires the current lease token (stale owners no-op). */
  markCancelled(
    jobId: number,
    leaseToken: string,
    reason?: string,
  ): Promise<void>;
  cancelStaleJobsForExternalUserId(
    platform: Platform,
    externalUserId: string,
    activeSessionKeys: string[],
    horizonEnd?: Date,
    options?: { statuses?: StudyReminderJobStatus[] },
  ): Promise<number>;
  /**
   * Consent opt-out (#596): cancel every cancellable job for this learner on
   * this platform so "tắt nhắc học" takes effect immediately, not at the
   * next sync.
   */
  cancelPendingJobsForExternalUser(
    platform: Platform,
    externalUserId: string,
    reason?: string,
  ): Promise<number>;
  cancelJobsFromOtherPlatforms(
    userId: number,
    currentPlatform: Platform,
    options?: { statuses?: StudyReminderJobStatus[] },
  ): Promise<number>;
  findNextDueTime(now: Date, platform?: Platform): Promise<Date | null>;
  /**
   * Resets jobs stuck in `processing` for THIS platform only — a worker must
   * never reopen another platform's processing job (#180). Target status
   * defaults to `failed`; callers may retain `pending` for compatibility, but
   * the persisted `ambiguous` outcome always suppresses a blind retry.
   */
  resetStuckProcessingJobs(
    platform: Platform,
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
