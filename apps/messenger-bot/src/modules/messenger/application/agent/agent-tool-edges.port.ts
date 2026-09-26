import type {
  WispaceExercisePrecreateResult,
  WispaceGoalsRecord,
} from '@wispace/chat-agent';

/** `get_user_goals` read for the tool surface (#1088). */
export interface AgentGoalsReadPort {
  getUserGoals(externalId: string): Promise<WispaceGoalsRecord>;
}

/** `precreate_next_exercise` call for the tool surface (#1088). */
export interface AgentExerciseCreatePort {
  precreateNextExercise(
    idHeader: 'x-psid',
    externalId: string,
    options?: { signal?: AbortSignal },
  ): Promise<WispaceExercisePrecreateResult>;
}

export const AGENT_GOALS_READ = Symbol('AGENT_GOALS_READ');
export const AGENT_EXERCISE_CREATE = Symbol('AGENT_EXERCISE_CREATE');
