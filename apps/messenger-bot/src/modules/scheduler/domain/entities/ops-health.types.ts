import type { ChatQuotaOpsSummary } from '@messenger/modules/chat-rate-limit/domain/entities/chat-quota-ops.types';
import type { StudyReminderOpsSummary } from '@messenger/modules/study-reminder/domain/entities/study-reminder-ops.types';
import type { MessengerPrivacyCleanupSummary } from '../repositories/privacy-cleanup-summary.port';
import type { OpsHealthAlert } from '@wispace/ops-health/core';

export type {
  OpsHealthAlert,
  OpsHealthAlertSeverity,
} from '@wispace/ops-health/core';

export interface OpsHealthSnapshot {
  generatedAt: string;
  chatQuota: ChatQuotaOpsSummary;
  studyReminder: StudyReminderOpsSummary;
  metaTokenExpiredEvents24h: number;
  llmSafetyWarnings24h: number;
  llmSafetyThresholdBreached: boolean;
  redisStatus: 'ok' | 'disabled' | 'unreachable';
  privacyCleanup?: MessengerPrivacyCleanupSummary;
  alerts: OpsHealthAlert[];
}
