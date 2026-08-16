/**
 * Learner profile — compact per-learner facts that survive chat-history TTL.
 *
 * Fields are written ONLY from server-derived tool results (grounding-safe,
 * same principle as the study-reminder `scheduledTimeLabel`): the LLM never
 * writes these values, it only reads them through the system prompt. Each
 * fact carries its own fetch timestamp so stale data can be skipped and the
 * model is steered back to the tools.
 */

export interface LearnerFacts {
  /** Band target (e.g. 7.0) — from `get_user_goals`. */
  targetScore?: number;
  /** Exam date `YYYY-MM-DD` — from `get_user_goals`. */
  examDate?: string;
  /** When `targetScore` was last fetched (server time). */
  targetScoreFetchedAt?: Date;
  /** When `examDate` was last fetched (server time). */
  examDateFetchedAt?: Date;
}

export interface LearnerProfile extends LearnerFacts {
  platform: string;
  externalUserId: string;
  /** WISPACE userId when the account is linked; undefined otherwise. */
  userId?: number | null;
}

/** Structural view of a persisted profile row. */
export interface LearnerProfileRow extends LearnerFacts {
  platform: string;
  externalUserId: string;
  userId: number | null;
  updatedAt: Date;
}

/** Minimal identity needed to record/serve a profile. */
export interface LearnerIdentity {
  externalUserId: string;
  userId?: number;
}
