import type { StudyReminderJob } from '../types/study-reminder.types';

/**
 * Focused lifecycle interface for study-reminder ops/monitoring/cleanup.
 * Only ops-related modules should depend on this interface.
 *
 * Methods: countJobsByStatus, countTerminalFailedSince, countStuckProcessing,
 *          findTerminalFailedSince, findStuckProcessing,
 *          deleteSentJobs, deleteTerminalJobsOlderThan
 */
export interface OpsJobRepository {
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
