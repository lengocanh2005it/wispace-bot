import { Injectable } from '@nestjs/common';
import { PlatformWebhookInboundEventService } from '@wispace/database';
import type {
  WebhookInboundEventsPort,
  WebhookIngestResult,
} from '../../domain/repositories/webhook-inbound-events.port';

/** Shared-durable-inbox adapter for `WebhookInboundEventsPort`. */
@Injectable()
export class MessengerWebhookInboundAdapter implements WebhookInboundEventsPort {
  constructor(
    private readonly inboundEvents: PlatformWebhookInboundEventService,
  ) {}

  ingest(input: {
    eventId: string;
    externalUserId?: string | null;
    eventType?: string | null;
    rawPayload: object;
  }): Promise<WebhookIngestResult> {
    return this.inboundEvents.ingest(input);
  }
}
