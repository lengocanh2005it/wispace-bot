/**
 * Shared durable webhook ingress interface — normalized persistence,
 * idempotent dedupe, bounded ingest, and retry semantics.
 *
 * Both Messenger and Zalo persist authenticated webhook events through
 * this interface before HTTP acknowledgement. Platform-specific adapters
 * handle event identity and payload normalization; this interface owns
 * the persistence contract.
 *
 * Lifecycle:
 *  1. Platform adapter normalizes event → calls `ingest()`
 *  2. `ingest()` persists to `webhook_inbound_events` (idempotent by event_id)
 *  3. HTTP 200 acknowledged
 *  4. Retry cron claims pending/failed rows and replays through `processEvent()`
 */

/** Result of a durable-inbox ingest attempt. */
export interface WebhookIngestResult {
  inserted: boolean;
  id?: number;
}

/**
 * Normalized durable webhook ingress port.
 *
 * Both Messenger and Zalo persist authenticated webhook events through
 * this interface before HTTP acknowledgement. The interface owns
 * normalized persistence, idempotent dedupe, and the ingest contract.
 *
 * Platform-specific adapters handle event identity and payload normalization.
 */
export interface WebhookInboundIngressPort {
  /**
   * Persist a single authenticated webhook event to the durable inbox.
   * Idempotent by eventId — duplicate deliveries return { inserted: false }.
   * Persistence failure must propagate so the endpoint answers non-2xx.
   */
  ingest(input: {
    eventId: string;
    externalUserId?: string | null;
    eventType?: string | null;
    rawPayload: object;
  }): Promise<WebhookIngestResult>;
}

export const WEBHOOK_INBOUND_INGRESS_PORT = Symbol(
  'WEBHOOK_INBOUND_INGRESS_PORT',
);
