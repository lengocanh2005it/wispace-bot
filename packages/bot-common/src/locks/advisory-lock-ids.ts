/**
 * Stable PostgreSQL session-level advisory lock IDs — shared by the Discord
 * and Zalo bots (Messenger keeps its own registry in
 * `apps/messenger-bot/src/shared/common/advisory-lock-ids.ts`).
 *
 * Never reuse, renumber, or change existing values.
 */
export const ADVISORY_LOCKS = {
  /** Messenger: daily report cron batch — managed by ReportCronLockService (R4). */
  MESSENGER_REPORT_CRON_DAILY: 884_200_801,
  /** Discord: daily report cron batch — managed by ReportCronLockService (#510). */
  DISCORD_REPORT_CRON_DAILY: 884_200_802,
  /** Zalo: daily report cron batch — managed by ReportCronLockService (#510). */
  ZALO_REPORT_CRON_DAILY: 884_200_803,
  /** Discord: dead-letter retry cron (every 5 min). */
  DISCORD_DEAD_LETTER_RETRY: 884_200_930,
  /** Zalo: dead-letter retry cron (every 5 min). */
  ZALO_DEAD_LETTER_RETRY: 884_200_931,
  /** Zalo: inbound webhook inbox retry cron (every 30s, `webhook_inbound_events`). */
  ZALO_WEBHOOK_INBOUND_RETRY: 884_200_932,
  /** Zalo: inbound webhook inbox raw-payload retention cleanup (03:15 ICT daily). */
  ZALO_WEBHOOK_INBOUND_CLEANUP: 884_200_933,
  /** Discord: link-verify reconciliation cron (every 5 min, `discord_link_verify_records`). */
  DISCORD_LINK_RECONCILE: 884_200_934,
  /** Zalo: link-verify reconciliation cron (every 5 min, `zalo_link_verify_records`) (#1160). */
  ZALO_LINK_RECONCILE: 884_200_937,
  /**
   * Platform-link-audit retention sweep (04:15 ICT daily), all three bots.
   *
   * One shared id on purpose. `PlatformLinkAuditCleanupService` deletes from
   * `platform_link_audit_events` with no platform filter, so every bot runs the
   * *same* global sweep over one shared table; serialising them avoids
   * concurrent runs deleting overlapping batches. Per-platform ids would starve
   * two platforms every day. #1500.
   */
  PLATFORM_LINK_AUDIT_CLEANUP: 884_200_942,
  // Retention-cron locks, per platform. These pair with the `lockIds` object the
  // cleanup-cron service takes; the retention *policy* half already lives in
  // `packages/cleanup-cron`'s policy registry (#1500).
  /** Discord: `message_logs` retention. */
  DISCORD_CLEANUP_MESSAGE_LOG: 884_200_911,
  /** Discord: dead-letter retention. */
  DISCORD_CLEANUP_DEAD_LETTER: 884_200_912,
  /** Discord: chat-idempotency stuck-recovery sweep. */
  DISCORD_CLEANUP_IDEMPOTENCY_RECOVERY: 884_200_914,
  /** Discord: chat-idempotency retention. */
  DISCORD_CLEANUP_IDEMPOTENCY: 884_200_915,
  /** Discord: OAuth-state retention. */
  DISCORD_CLEANUP_OAUTH_STATE: 884_200_939,
  /** Discord: scheduled-report-claim retention. */
  DISCORD_CLEANUP_REPORT_CLAIM: 884_200_920,
  /** Zalo: `message_logs` retention. */
  ZALO_CLEANUP_MESSAGE_LOG: 884_200_916,
  /** Zalo: dead-letter retention. */
  ZALO_CLEANUP_DEAD_LETTER: 884_200_917,
  /** Zalo: chat-idempotency stuck-recovery sweep. */
  ZALO_CLEANUP_IDEMPOTENCY_RECOVERY: 884_200_918,
  /** Zalo: chat-idempotency retention. */
  ZALO_CLEANUP_IDEMPOTENCY: 884_200_919,
  /** Zalo: OAuth-state retention. */
  ZALO_CLEANUP_OAUTH_STATE: 884_200_913,
  /** Zalo: scheduled-report-claim retention. */
  ZALO_CLEANUP_REPORT_CLAIM: 884_200_921,
  /** Discord: stale scheduled-report-claim lease reset. */
  DISCORD_REPORT_CLAIM_STALE_RESET: 884_200_935,
  /** Zalo: stale scheduled-report-claim lease reset. */
  ZALO_REPORT_CLAIM_STALE_RESET: 884_200_936,
  /** Discord: study-reminder worker sync lock (30 min, per-platform #777). */
  DISCORD_STUDY_REMINDER_SYNC: 884_200_944,
  /** Discord: study-reminder terminal-job cleanup lock (03:00 ICT, per-platform #777). */
  DISCORD_STUDY_REMINDER_CLEANUP: 884_200_945,
  /** Discord: study-reminder evening rollover lock (per-platform #777). */
  DISCORD_STUDY_REMINDER_ROLLOVER: 884_200_946,
  /** Discord: re-engagement daily batch lock (#854). */
  DISCORD_REENGAGEMENT: 884_200_950,
  /** Discord: report retry-dispatch cron (every 15 min, `report_send_jobs`) (#521). */
  DISCORD_REPORT_RETRY_DISPATCH: 884_200_951,
  /** Shared: reschedule-recovery cron across all bots (every 5 min, `reschedule_confirmations`) (#464). */
  RESCHEDULE_RECOVERY: 884_200_952,
  /** Zalo: study-reminder worker sync lock (30 min, per-platform #777). */
  ZALO_STUDY_REMINDER_SYNC: 884_200_947,
  /** Zalo: study-reminder terminal-job cleanup lock (03:00 ICT, per-platform #777). */
  ZALO_STUDY_REMINDER_CLEANUP: 884_200_948,
  /** Zalo: study-reminder evening rollover lock (per-platform #777). */
  ZALO_STUDY_REMINDER_ROLLOVER: 884_200_949,
  /** Shared scheduled data-quality checks (Messenger runs it today; reserved for cross-bot coordination). */
  DATA_QUALITY_CHECK: 884_200_943,
  /** Discord/Zalo: durable privacy state cleanup recovery (every 5 min). */
  PRIVACY_CLEANUP_DISCORD: 884_200_954,
  PRIVACY_CLEANUP_ZALO: 884_200_955,
} as const;
