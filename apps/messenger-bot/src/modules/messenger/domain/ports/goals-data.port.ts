import type { UserGoalsRecord } from '@wispace/wispace-client';

export type { UserGoalsRecord };

export const GOALS_DATA_PORT = Symbol('GOALS_DATA_PORT');

export interface GoalsDataPort {
  getUserGoals(psid: string): Promise<UserGoalsRecord>;
}
