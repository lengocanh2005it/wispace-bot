/**
 * Narrow WISPACE capability contracts (#425): the shared tool executor depends
 * on these ports instead of concrete `@wispace/wispace-client` classes.
 * Adapters are wired by each consuming bot's composition root (Discord, Zalo;
 * Messenger owns its executor). The `Wispace*` types mirror the client shapes
 * the shared code actually consumes — adapters return the full client objects,
 * which satisfy them structurally, so runtime behavior is unchanged.
 */

/** Full mirror of wispace-client `UserGoalsRecord` — passed raw to the model. */
export interface WispaceGoalsRecord {
  targetScore: number;
  examDate: string;
}

/** Subset of wispace-client `TaskScoreAverageRecord` consumed by report formatting. */
export interface WispaceTaskScoreView {
  task1Count: number;
  task2Count: number;
}

/** Same union as wispace-client `CalendarSessionTimeRange` / llm-agent `readCalendarTimeRange`. */
export type WispaceCalendarTimeRange = 'upcoming' | 'past' | 'all';

/** Subset of wispace-client `NormalizedStudySession` consumed by session mapping. */
export interface WispaceCalendarSessionView {
  sessionKey: string;
  scheduledAt: Date;
  topic: string;
}

/** Full mirror of wispace-client `PrecreateExerciseResult` (4-status union). */
export interface WispaceExercisePrecreateResult {
  status: 'created' | 'already_exists' | 'finished_all' | 'no_roadmap';
  exerciseUrl?: string;
  message?: string;
}

export interface GoalsCapabilityPort {
  getUserGoals(
    externalId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WispaceGoalsRecord>;
  getTaskScoreAverages(
    externalId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WispaceTaskScoreView[]>;
}

export interface CalendarCapabilityPort {
  getCalendarSessions(
    externalId: string,
    options?: {
      timeRange?: WispaceCalendarTimeRange;
      pastDays?: number;
      limit?: number;
      signal?: AbortSignal;
    },
  ): Promise<WispaceCalendarSessionView[]>;
}

export interface ExerciseCapabilityPort {
  precreateNextExercise(
    externalId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WispaceExercisePrecreateResult>;
}
