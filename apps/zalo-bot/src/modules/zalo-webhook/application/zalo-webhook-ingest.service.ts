import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { maskEventId } from '@wispace/bot-common/masking';
import {
  PlatformWebhookInboundEventService,
  type WebhookInboundIngressPort,
} from '@wispace/webhook-inbound';
import type { ZaloWebhookEvent } from '../domain/entities/zalo-webhook-event.types';

/** Stable per-delivery event id for the durable inbox. */
export function buildZaloEventId(event: ZaloWebhookEvent): string {
  if (event.message?.msg_id) {
    return event.message.msg_id;
  }
  const userId = event.sender?.id ?? event.follower?.id ?? 'unknown';
  if (event.timestamp) {
    return `${event.event_name}:${userId}:${event.timestamp}`;
  }
  // ponytail: deterministic content hash — same payload always produces the
  // same key, even across redeliveries with no msg_id or timestamp.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(event))
    .digest('hex');
  return `${event.event_name}:${userId}:${fingerprint}`;
}

/**
 * Write-ahead ingestion for authenticated Zalo webhook events. Downstream
 * dispatch is owned by the advisory-locked retry cron after the HTTP ACK.
 * Implements the shared WebhookInboundIngressPort for normalized persistence.
 */
@Injectable()
export class ZaloWebhookIngestService implements WebhookInboundIngressPort {
  private readonly logger = new Logger(ZaloWebhookIngestService.name);

  constructor(
    private readonly inboundEvents: PlatformWebhookInboundEventService,
    @Optional()
    @Inject('TRY_INLINE_DISPATCHER')
    private readonly tryInlineDispatcher?:
      | ((
          id: number,
          rawPayload: object,
          meta: { ingestedAt: Date; eventId: string; externalUserId: string },
        ) => void)
      | null,
  ) {}

  async ingestEvent(body: ZaloWebhookEvent): Promise<boolean> {
    const eventId = buildZaloEventId(body);
    const externalUserId = body.sender?.id ?? body.follower?.id ?? null;
    const { inserted, id } = await this.inboundEvents.ingest({
      eventId,
      externalUserId,
      eventType: body.event_name,
      rawPayload: body,
    });

    if (!inserted) {
      this.logger.debug(
        `Skipping duplicate webhook event id=${maskEventId(
          eventId,
          externalUserId,
        )}`,
      );
      return false;
    }

    if (this.tryInlineDispatcher && id) {
      this.tryInlineDispatcher(id, body as unknown as object, {
        ingestedAt: new Date(),
        eventId,
        externalUserId: externalUserId ?? '',
      });
    }

    return true;
  }

  /**
   * Shared WebhookInboundIngressPort implementation.
   * Delegates to ingestEvent for platform-specific normalization.
   */
  async ingest(input: {
    eventId: string;
    externalUserId?: string | null;
    eventType?: string | null;
    rawPayload: object;
  }): Promise<{ inserted: boolean; id?: number }> {
    return this.inboundEvents.ingest(input);
  }
}
