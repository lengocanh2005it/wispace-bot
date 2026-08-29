/**
 * Persistence-only contracts owned by @wispace/database.
 *
 * Cross-context contracts (Platform, PlatformLinkState, ReportSendJobStatus,
 * OutboundDeliveryOutcome, MessageType) live in @wispace/contracts.
 */

export type PlatformLinkObservation =
  | { kind: 'active'; userId: number; ownershipVersion?: string }
  | { kind: 'revoked'; reason: string; ownershipVersion?: string }
  | { kind: 'unknown'; reason: string };

export type PlatformLinkAuditEventType =
  | 'revoked'
  | 'unknown'
  | 'recovered'
  | 'stale_writer'
  | 'locally_unlinked';

/** Scheduled report claim status. */
export type ScheduledReportClaimStatus =
  | 'claimed'
  | 'sent'
  | 'released'
  | 'cancelled';

/** Webhook dead letter status. */
export type WebhookDeadLetterStatus = 'pending' | 'replayed' | 'abandoned';

/** Durable inbound webhook inbox status — `abandoned` is terminal after bounded retries. */
export type WebhookInboundEventStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'abandoned';
