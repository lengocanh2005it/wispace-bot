import type { StudySessionRecord } from '../types/study-reminder.types';

/**
 * Optional hooks for the dispatch lifecycle.
 * Messenger injects this; Discord/Zalo leave it undefined (all optional).
 *
 * Merges ReminderGeneratorPort + MetricsHook + ErrorClassifierPort
 * into a single composite port to reduce DI surface.
 */
export const DISPATCH_HOOKS = Symbol('DISPATCH_HOOKS');

export interface DispatchHooksPort {
  /** LLM-generated reminder text. Falls back to template when absent. */
  generateReminder?(
    session: StudySessionRecord,
    ctx: {
      externalUserId: string;
      userId?: number;
      timeLabel: string;
      minutesUntil: number;
      jobId?: number;
    },
  ): Promise<string>;

  /** Called after a reminder is sent successfully. */
  onSent?(ctx: { jobId: number; externalUserId: string }): void;

  /** Called after a terminal failure (no more retries). */
  onFailed?(ctx: {
    jobId: number;
    externalUserId: string;
    error: string;
  }): void;

  /** Called when a non-terminal failure triggers a retry. */
  onRetried?(ctx: {
    jobId: number;
    externalUserId: string;
    retryCount: number;
  }): void;

  /** Called when a job is cancelled (session started, link revoked, dormant). */
  onCancelled?(ctx: {
    jobId: number;
    externalUserId: string;
    reason: string;
  }): void;

  /** Returns true if the error should NOT be retried (mark job terminal). */
  isTerminalError?(error: unknown): boolean;
}
