import type { ChatQuotaOpsSummary } from '@messenger/modules/chat-rate-limit/domain/entities/chat-quota-ops.types';
import type { StudyReminderOpsSummary } from '@messenger/modules/study-reminder/domain/entities/study-reminder-ops.types';

export type OpsHealthAlertSeverity = 'warn' | 'info';

export interface OpsHealthAlert {
  code: string;
  severity: OpsHealthAlertSeverity;
  message: string;
}

export interface OpsHealthSnapshot {
  generatedAt: string;
  chatQuota: ChatQuotaOpsSummary;
  studyReminder: StudyReminderOpsSummary;
  metaTokenExpiredEvents24h: number;
  llmSafetyWarnings24h: number;
  llmSafetyThresholdBreached: boolean;
  alerts: OpsHealthAlert[];
}
