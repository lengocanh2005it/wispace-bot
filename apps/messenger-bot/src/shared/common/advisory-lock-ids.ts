/**
 * Stable PostgreSQL session-level advisory lock IDs.
 * Never reuse, renumber, or change existing values.
 */
export const ADVISORY_LOCK = {
  /** R4: daily report cron batch — managed by ReportCronLockService */
  REPORT_CRON_DAILY: 884_200_801,

  /** Full sync: Wispace UserCalendar → study_reminder_jobs upsert. */
  STUDY_REMINDER_SYNC: 884_200_901,

  /** Delete terminal/sent jobs (cleanup cron 03:00). */
  STUDY_REMINDER_CLEANUP: 884_200_902,

  /** Evening rollover: purge sent jobs + full sync. */
  STUDY_REMINDER_ROLLOVER: 884_200_903,

  /** Inbound webhook inbox retry cron (every 30s, `webhook_inbound_events`). */
  MESSENGER_WEBHOOK_INBOUND_RETRY: 884_200_905,

  /** Inbound webhook inbox raw-payload retention cleanup (03:15 ICT daily). */
  MESSENGER_WEBHOOK_INBOUND_CLEANUP: 884_200_910,

  /** R5: report send retry dispatch (every 15 min). */
  REPORT_SEND_RETRY_DISPATCH: 884_200_909,

  /** H2: auto-refund quota slots stuck in `reserved` (every 5 min). */
  CHAT_QUOTA_STUCK_RECOVERY: 884_200_906,

  /** Release scheduled_report_claims stuck in `claimed` (every 30 min). */
  REPORT_CLAIM_STALE_RESET: 884_200_907,
} as const;
