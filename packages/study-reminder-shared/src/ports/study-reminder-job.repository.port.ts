import type {
  StudyReminderJob,
  UpsertStudyReminderJobInput,
} from '../types/study-reminder.types';

export type { StudyReminderJob, UpsertStudyReminderJobInput };

export const STUDY_REMINDER_JOB_REPOSITORY = Symbol(
  'STUDY_REMINDER_JOB_REPOSITORY',
);

export interface StudyReminderJobRepositoryPort {
  upsertPendingJob(
    input: UpsertStudyReminderJobInput,
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
  ): Promise<number>;
  cancelJobsFromOtherPlatforms(
    userId: number,
    currentPlatform: string,
  ): Promise<number>;
  findNextDueTime(now: Date): Promise<Date | null>;
  resetStuckProcessingJobs(olderThan: Date): Promise<number>;
  deleteSentJobs(olderThan: Date): Promise<number>;
  deleteTerminalJobsOlderThan(olderThan: Date): Promise<number>;
  countJobsByStatus(platform: string): Promise<Record<string, number>>;
  countTerminalFailedSince(since: Date): Promise<number>;
  findStuckProcessing(
    olderThan: Date,
    limit?: number,
  ): Promise<StudyReminderJob[]>;
}
