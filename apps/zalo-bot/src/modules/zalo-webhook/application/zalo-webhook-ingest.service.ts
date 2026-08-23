import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { maskEventId } from '@wispace/bot-common';
import { PlatformWebhookInboundEventService } from '@wispace/database';
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
 */
@Injectable()
export class ZaloWebhookIngestService {
  private readonly logger = new Logger(ZaloWebhookIngestService.name);

  constructor(
    private readonly inboundEvents: PlatformWebhookInboundEventService,
  ) {}

  async ingestEvent(body: ZaloWebhookEvent): Promise<boolean> {
    const eventId = buildZaloEventId(body);
    const externalUserId = body.sender?.id ?? body.follower?.id ?? null;
    const { inserted } = await this.inboundEvents.ingest({
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

    return true;
  }
}
