import type { DataQualityConfig } from './data-quality.types';

export interface DataQualityTableRule {
  table: string;
  keyColumn: string;
  timeColumn: string;
  userColumn?: string;
  externalUserColumn?: string;
  platformColumn?: string;
}

export interface DataQualityTimestampRule extends DataQualityTableRule {
  label: string;
  condition?: string;
}

export interface DataQualityTerminalRule extends DataQualityTableRule {
  label: string;
  terminalCondition: string;
}

export interface DataQualityStuckRule extends DataQualityTableRule {
  label: string;
  stuckCondition: string;
  parameters: (input: { now: Date; config: DataQualityConfig }) => unknown[];
}

const userScopedRules: DataQualityTableRule[] = [
  {
    table: 'user_platform_mappings',
    keyColumn: 'id',
    timeColumn: 'created_at',
    userColumn: 'user_id',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
  },
  {
    table: 'chat_daily_usage',
    keyColumn: 'id',
    timeColumn: 'created_at',
    userColumn: 'user_id',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
  },
  {
    table: 'chat_idempotency',
    keyColumn: 'idempotency_key',
    timeColumn: 'reserved_at',
    userColumn: 'user_id',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
  },
  {
    table: 'chat_quota_events',
    keyColumn: 'id',
    timeColumn: 'occurred_at',
    userColumn: 'user_id',
    platformColumn: 'platform',
  },
  {
    table: 'study_reminder_jobs',
    keyColumn: 'id',
    timeColumn: 'created_at',
    userColumn: 'user_id',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
  },
  {
    table: 'report_send_jobs',
    keyColumn: 'id',
    timeColumn: 'created_at',
    userColumn: 'user_id',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
  },
  {
    table: 'scheduled_report_claims',
    keyColumn: 'id',
    timeColumn: 'created_at',
    userColumn: 'user_id',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
  },
  {
    table: 'learner_profiles',
    keyColumn: 'external_user_id',
    timeColumn: 'updated_at',
    userColumn: 'user_id',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
  },
  {
    table: 'llm_usage_events',
    keyColumn: 'id',
    timeColumn: 'occurred_at',
    userColumn: 'user_id',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
  },
  {
    table: 'llm_safety_events',
    keyColumn: 'id',
    timeColumn: 'created_at',
    userColumn: 'user_id',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
  },
];

// Mapping rows may be anonymous before account linking; only tables whose
// null user_id should resolve after ingestion participate in this check.
export const NULL_SPIKE_RULES = userScopedRules.filter(
  (rule) => rule.table !== 'user_platform_mappings',
);

export const ORPHAN_RULES = userScopedRules;

export const VOLUME_RULES: DataQualityTableRule[] = [
  ...NULL_SPIKE_RULES,
  {
    table: 'message_logs',
    keyColumn: 'id',
    timeColumn: 'created_at',
    userColumn: 'user_id',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
  },
  {
    table: 'webhook_inbound_events',
    keyColumn: 'id',
    timeColumn: 'created_at',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
  },
  {
    table: 'webhook_dead_letters',
    keyColumn: 'id',
    timeColumn: 'created_at',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
  },
];

export const FUTURE_TIMESTAMP_RULES: DataQualityTimestampRule[] = [
  ...VOLUME_RULES.map((rule) => ({
    ...rule,
    label: `${rule.table}.${rule.timeColumn}`,
  })),
  // Pending/processing sessions legitimately point into the future; terminal
  // rows with future schedule fields are not valid.
  {
    table: 'study_reminder_jobs',
    keyColumn: 'id',
    timeColumn: 'scheduled_at',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
    label: 'study_reminder_jobs.scheduled_at',
    condition: `status IN ('sent', 'failed', 'cancelled')`,
  },
  {
    table: 'study_reminder_jobs',
    keyColumn: 'id',
    timeColumn: 'remind_at',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
    label: 'study_reminder_jobs.remind_at',
    condition: `status IN ('sent', 'failed', 'cancelled')`,
  },
  {
    table: 'chat_idempotency',
    keyColumn: 'idempotency_key',
    timeColumn: 'updated_at',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
    label: 'chat_idempotency.updated_at',
  },
  {
    table: 'reschedule_confirmations',
    keyColumn: 'id',
    timeColumn: 'updated_at',
    userColumn: 'user_id',
    platformColumn: 'platform',
    label: 'reschedule_confirmations.updated_at',
  },
];

export const TERMINAL_TIMESTAMP_RULES: DataQualityTerminalRule[] = [
  {
    table: 'study_reminder_jobs',
    keyColumn: 'id',
    timeColumn: 'updated_at',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
    label: 'study_reminder_jobs.sent_at',
    terminalCondition: `status = 'sent' AND sent_at IS NULL`,
  },
  {
    table: 'report_send_jobs',
    keyColumn: 'id',
    timeColumn: 'updated_at',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
    label: 'report_send_jobs.sent_at',
    terminalCondition: `status = 'sent' AND sent_at IS NULL`,
  },
  {
    table: 'webhook_inbound_events',
    keyColumn: 'id',
    timeColumn: 'updated_at',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
    label: 'webhook_inbound_events.processed_at',
    terminalCondition: `status IN ('completed', 'abandoned') AND processed_at IS NULL`,
  },
  {
    table: 'webhook_dead_letters',
    keyColumn: 'id',
    timeColumn: 'updated_at',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
    label: 'webhook_dead_letters.replayed_at',
    terminalCondition: `status = 'replayed' AND replayed_at IS NULL`,
  },
];

function ageBefore(now: Date, ageMs: number, graceMs: number): Date {
  return new Date(now.getTime() - ageMs - graceMs);
}

export const STUCK_STATE_RULES: DataQualityStuckRule[] = [
  {
    table: 'chat_idempotency',
    keyColumn: 'idempotency_key',
    timeColumn: 'reserved_at',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
    label: 'chat_idempotency.reserved',
    stuckCondition: `status = 'reserved' AND reserved_at < $1::timestamptz`,
    parameters: ({ now, config }) => [
      ageBefore(now, config.stuckReservedMs, config.stuckGraceMs),
    ],
  },
  {
    table: 'webhook_inbound_events',
    keyColumn: 'id',
    timeColumn: 'updated_at',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
    label: 'webhook_inbound_events.processing',
    stuckCondition: `status = 'processing' AND updated_at < $1::timestamptz`,
    parameters: ({ now, config }) => [
      ageBefore(now, config.webhookProcessingStuckMs, config.stuckGraceMs),
    ],
  },
  {
    table: 'study_reminder_jobs',
    keyColumn: 'id',
    timeColumn: 'updated_at',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
    label: 'study_reminder_jobs.processing',
    stuckCondition: `status = 'processing' AND ((lease_expires_at IS NOT NULL AND lease_expires_at < $1::timestamptz) OR (lease_expires_at IS NULL AND updated_at < $2::timestamptz))`,
    parameters: ({ now, config }) => [
      new Date(now.getTime() - config.stuckGraceMs),
      ageBefore(
        now,
        config.studyReminderProcessingStuckMs,
        config.stuckGraceMs,
      ),
    ],
  },
  {
    table: 'report_send_jobs',
    keyColumn: 'id',
    timeColumn: 'updated_at',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
    label: 'report_send_jobs.processing',
    stuckCondition: `status = 'processing' AND ((lease_expires_at IS NOT NULL AND lease_expires_at < $1::timestamptz) OR (lease_expires_at IS NULL AND updated_at < $2::timestamptz))`,
    parameters: ({ now, config }) => [
      new Date(now.getTime() - config.stuckGraceMs),
      ageBefore(now, config.reportSendProcessingStuckMs, config.stuckGraceMs),
    ],
  },
  {
    table: 'scheduled_report_claims',
    keyColumn: 'id',
    timeColumn: 'updated_at',
    externalUserColumn: 'external_user_id',
    platformColumn: 'platform',
    label: 'scheduled_report_claims.claimed',
    stuckCondition: `status = 'claimed' AND ((lease_expires_at IS NOT NULL AND lease_expires_at < $1::timestamptz) OR (lease_expires_at IS NULL AND updated_at < $2::timestamptz))`,
    parameters: ({ now, config }) => [
      new Date(now.getTime() - config.stuckGraceMs),
      ageBefore(now, config.reportClaimProcessingStuckMs, config.stuckGraceMs),
    ],
  },
];
