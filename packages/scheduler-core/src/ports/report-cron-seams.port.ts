import type { Platform } from '@wispace/contracts';
import type { ExamWindowResult } from '../services/report-schedule.service';
import type { ClassifiedError } from '../services/report-orchestration.service';
import type {
  ClaimAndSendResult,
  ReportMapping,
} from '../types/report-send-job.types';

export type { ClassifiedError };

/** Options the platform-agnostic report orchestration accepts. */
export interface ReportOrchestrationOptions {
  reportDate: string;
  skipAlreadySentToday: boolean;
  allowUserIdLess?: boolean;
  reportText: string;
  examDateForOutbox?: string;
  classifyError: (error: unknown) => ClassifiedError;
  generateReport: () => Promise<string>;
}

/** Platform-agnostic claim-and-send seam (#1088). */
export interface ReportOrchestrationPort {
  claimAndSend(
    mapping: ReportMapping,
    options: ReportOrchestrationOptions,
  ): Promise<ClaimAndSendResult>;
}

export interface ExamReminderWindow {
  minDays: number;
  maxDays: number;
}

export interface ReportOutboxSettings {
  maxRetries: number;
  retryBackoffMinutes: number;
  retryPollCronMinutes: number;
  leaseMs: number;
  claimLeaseMs: number;
  timezone: string;
}

/** Leader election for the 08:00 report wave (#1088). */
export interface ReportCronLeaderPort {
  shouldRunScheduledReportCron(): Promise<boolean>;
}

/** Daily advisory lock held by the report wave (#1088). */
export interface ReportCronLockPort {
  tryAcquireDailyLock(): Promise<boolean>;
  releaseDailyLock(): Promise<void>;
}

/** Exam-window policy reads (#1088). */
export interface ReportSchedulePort {
  getExamReminderWindow(): ExamReminderWindow;
  shouldSendReportToday(externalUserId: string): Promise<ExamWindowResult>;
  calculateDaysUntilExam(examDateIso: string, today?: Date): number;
}

/** Outbox tuning read from config (#1088). */
export interface ReportSendSchedulePort {
  getOutboxSettings(): ReportOutboxSettings;
}

/** Advisory-lock wrapper for batch jobs (#1088). */
export interface AdvisoryLockPort {
  withLock<T>(lockId: number, run: () => Promise<T>): Promise<T | null>;
}

/** Cross-platform ownership check for report recipients (#1088). */
export interface CanonicalPlatformPort {
  getCanonicalPlatformsForUsers(
    userIds: readonly number[],
  ): Promise<Map<number, Platform | undefined>>;
}

/** Dormant-learner suppression of proactive reports (#1088). */
export interface WebActivityPort {
  partitionDormant<T>(
    items: T[],
    getUserId: (item: T) => number | null | undefined,
  ): Promise<{ active: T[]; suppressed: number }>;
}
