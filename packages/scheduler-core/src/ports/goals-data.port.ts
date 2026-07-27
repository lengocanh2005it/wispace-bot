export const GOALS_DATA_PORT = Symbol('GOALS_DATA_PORT');

export interface GoalsDataPort {
  getUserGoals(externalUserId: string): Promise<{ examDate: string }>;
  parseExamDate(examDate: string): string;
}
