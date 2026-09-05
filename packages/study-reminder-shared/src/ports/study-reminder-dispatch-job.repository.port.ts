import type { StudyReminderJob } from '../types/study-reminder.types';
import type { OutboundDeliveryOutcome, Platform } from '@wispace/contracts';

/**
 * Focused lifecycle interface for study-reminder dispatch operations.
 * Only dispatch-related modules should depend on this interface.
 *
 * Methods: findDueJobs, claimJob, markSent, markDeliveryKey,
 *          markFailed, markCancelled, resetStuckProcessingJobs, findNextDueTime
 */
export interface DispatchJobRepository {
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

  findNextDueTime(now: Date, platform?: Platform): Promise<Date | null>;
}
