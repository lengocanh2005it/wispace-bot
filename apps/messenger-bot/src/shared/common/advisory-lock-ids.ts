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

  /** Auto-retry cron for messenger_webhook_dead_letters. */
  MESSENGER_WEBHOOK_DEAD_LETTER_RETRY: 884_200_905,

  /** R5: report send retry dispatch (every 15 min). */
  REPORT_SEND_RETRY_DISPATCH: 884_200_909,
} as const;
