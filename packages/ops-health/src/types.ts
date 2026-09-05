import type { PlatformConnectivitySnapshot } from '@wispace/bot-common/health';

export type OpsHealthAlertSeverity = 'critical' | 'warn' | 'info';

export interface OpsHealthAlert {
  code: string;
  severity: OpsHealthAlertSeverity;
  message: string;
}

export interface WebhookInboundOpsSummary {
  pendingCount: number;
  failedCount: number;
  stuckProcessingCount: number;
  oldestPendingAgeSeconds: number | null;
}

export interface DeadLetterOpsSummary {
  outboundPendingCount: number;
  outboundFailedCount: number;
  oldestPendingAgeSeconds: number | null;
}

export interface ChatQuotaOpsSummary {
  denyLogs24h: number;
  stuckReserved: number;
  usersAtDailyLimit: number;
  [key: string]: unknown;
}

export interface StudyReminderOpsSummary {
  countsByStatus: Record<string, number>;
  terminalFailedSince: number;
  stuckProcessing: number;
  [key: string]: unknown;
}

export interface CronHeartbeatInfo {
  name: string;
  expectedIntervalMs: number;
  lastTickAt: string | null;
  lastSuccessAt: string | null;
  lastError?: string | null;
  status: 'healthy' | 'stale' | 'never_run';
}

export interface OpsHealthSnapshot {
  generatedAt: string;
  status: 'ok' | 'degraded' | 'error';
  infrastructure: {
    database: 'connected' | 'disconnected' | 'unknown';
    redis: 'connected' | 'disabled' | 'error' | 'unreachable' | 'unknown';
    platform?: PlatformConnectivitySnapshot;
    dbCircuitBreaker?: 'closed' | 'half_open' | 'open' | 'unknown';
  };
  queues: {
    webhookInbound?: WebhookInboundOpsSummary;
    deadLetter?: DeadLetterOpsSummary;
    chatQuota?: ChatQuotaOpsSummary;
    studyReminder?: StudyReminderOpsSummary;
  };
  crons?: Record<string, CronHeartbeatInfo>;
  llm?: {
    safetyWarnings24h: number;
    safetyThresholdBreached: boolean;
  };
  alerts: OpsHealthAlert[];
  [key: string]: unknown;
}

export const OPS_HEALTH_REPOSITORY = Symbol('OPS_HEALTH_REPOSITORY');
export const OPS_HEALTH_SERVICE = Symbol('OPS_HEALTH_SERVICE');
export const CRON_HEARTBEAT_REGISTRY = Symbol('CRON_HEARTBEAT_REGISTRY');

export interface OpsHealthRepositoryPort {
  getChatQuotaSummary(): Promise<ChatQuotaOpsSummary>;
  getStudyReminderSummary(options?: {
    failedSinceHours?: number;
    stuckProcessingMinutes?: number;
  }): Promise<StudyReminderOpsSummary>;
  getLlmSafetyWarningsCount(since: Date): Promise<number>;
  getWebhookInboundSummary?(): Promise<WebhookInboundOpsSummary>;
  getDeadLetterSummary?(): Promise<DeadLetterOpsSummary>;
  isDatabaseReachable?(): Promise<boolean>;
}

export interface RedisHealthPort {
  isEnabled(): boolean;
  isConfiguredEnabled(): boolean;
  ping(): Promise<string>;
}

export interface ApplicationReadinessResult {
  ready: boolean;
  status: 'ok' | 'error';
  reason?: string;
}

export interface OpsHealthServicePort {
  isEnabled(): boolean;
  collectSnapshot(
    platformSnapshot?: PlatformConnectivitySnapshot,
  ): Promise<OpsHealthSnapshot>;
  isApplicationReady(
    platformSnapshot?: PlatformConnectivitySnapshot,
  ): Promise<ApplicationReadinessResult>;
  logSnapshotIfNeeded(): Promise<void>;
}
