import type {
  StudyReminderJob,
  UpsertStudyReminderJobInput,
} from '../types/study-reminder.types';
import type { Platform } from '@wispace/contracts';
import type { UpsertStudyReminderJobOptions } from './study-reminder-job.repository.port';

/**
 * Focused lifecycle interface for study-reminder sync operations.
 * Only sync-related modules should depend on this interface.
 *
 * Methods: upsertPendingJobs, cancelStaleJobsForExternalUserId,
 *          cancelJobsFromOtherPlatforms
 */
export interface SyncJobRepository {
  /**
   * Batch upsert — one SELECT for all keys, then in-memory reopen logic and
   * batched save. Same per-row semantics as `upsertPendingJob` (no lockKey).
   */
  upsertPendingJobs(
    inputs: UpsertStudyReminderJobInput[],
    options?: UpsertStudyReminderJobOptions,
  ): Promise<StudyReminderJob[]>;

  cancelStaleJobsForExternalUserId(
    platform: Platform,
    externalUserId: string,
    activeSessionKeys: string[],
    horizonEnd?: Date,
    options?: { statuses?: string[] },
  ): Promise<number>;

  cancelJobsFromOtherPlatforms(
    userId: number,
    currentPlatform: Platform,
    options?: { statuses?: string[] },
  ): Promise<number>;
}
