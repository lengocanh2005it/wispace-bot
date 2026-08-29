/**
 * Chat quota/idempotency contracts owned by @wispace/chat-metering (#423).
 * These used to be exported from @wispace/database; the database package no
 * longer re-exports them — import from @wispace/chat-metering.
 */

/** Chat quota deny reasons. */
export type ChatQuotaDenyReason =
  | 'DAILY_LIMIT'
  | 'BURST_LIMIT'
  | 'NOT_LINKED'
  | 'IDEMPOTENCY_CONFLICT';

/** Chat idempotency row status. */
export type ChatIdempotencyStatus =
  | 'reserved'
  | 'delivered'
  | 'completed'
  | 'refunded';

/** Chat quota release reasons. */
export type ChatQuotaReleaseReason = 'send_failed' | 'stuck_recover';
