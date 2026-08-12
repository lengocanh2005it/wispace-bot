/**
 * Stable PostgreSQL session-level advisory lock IDs — shared by the Discord
 * and Zalo bots (Messenger keeps its own registry in
 * `apps/messenger-bot/src/shared/common/advisory-lock-ids.ts`).
 *
 * Never reuse, renumber, or change existing values.
 */
export const ADVISORY_LOCKS = {
  /** Discord: dead-letter retry cron (every 5 min). */
  DISCORD_DEAD_LETTER_RETRY: 884_200_930,
  /** Zalo: dead-letter retry cron (every 5 min). */
  ZALO_DEAD_LETTER_RETRY: 884_200_931,
  /** Zalo: inbound webhook inbox retry cron (every 30s, `webhook_inbound_events`). */
  ZALO_WEBHOOK_INBOUND_RETRY: 884_200_932,
} as const;
