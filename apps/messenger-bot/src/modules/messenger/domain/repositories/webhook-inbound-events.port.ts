/** Result of a durable-inbox ingest attempt. */
export interface WebhookIngestResult {
  inserted: boolean;
  id?: number;
}

/**
 * Durable webhook inbox port — every authenticated inbound event is persisted
 * before the endpoint acks (idempotent by event id; persistence failure must
 * propagate as non-2xx). Implemented by the shared
 * `PlatformWebhookInboundEventService` adapter in `infrastructure/`.
 */
export interface WebhookInboundEventsPort {
  ingest(input: {
    eventId: string;
    externalUserId?: string | null;
    eventType?: string | null;
    rawPayload: object;
  }): Promise<WebhookIngestResult>;
}

export const WEBHOOK_INBOUND_EVENTS_PORT = Symbol(
  'WEBHOOK_INBOUND_EVENTS_PORT',
);
