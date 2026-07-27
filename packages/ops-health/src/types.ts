export type OpsHealthAlertSeverity = 'warn' | 'info';

export interface OpsHealthAlert {
  code: string;
  severity: OpsHealthAlertSeverity;
  message: string;
}

export interface OpsHealthSnapshot {
  generatedAt: string;
  alerts: OpsHealthAlert[];
  [key: string]: unknown;
}

export const OPS_HEALTH_REPOSITORY = Symbol('OPS_HEALTH_REPOSITORY');

export interface OpsHealthRepositoryPort {
  getChatQuotaSummary(): Promise<Record<string, unknown>>;
  getStudyReminderSummary(): Promise<Record<string, unknown>>;
  getLlmSafetyWarningsCount(since: Date): Promise<number>;
}
