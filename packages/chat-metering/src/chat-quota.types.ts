/**
 * The chat idempotency status owned by @wispace/chat-metering (#423). It used
 * to be exported from @wispace/database; the database package no longer
 * re-exports contracts — import from @wispace/chat-metering.
 *
 * The deny and release reasons moved to @wispace/contracts (ADR-0043): a
 * deciding context, an applying context, and a recording context all read
 * them. This status stays because it is the lifecycle of this package's own
 * rows and no other context interprets it.
 */

/** Chat idempotency row status. */
export type ChatIdempotencyStatus =
  | 'reserved'
  | 'delivered'
  | 'completed'
  | 'refunded';
