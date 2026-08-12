import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  errorMessage,
  maskEventId,
  maskExternalIdInText,
} from '@wispace/bot-common';
import {
  PlatformWebhookInboundEventService,
  readInboundRetryConfig,
} from '@wispace/database';
import type { ZaloWebhookEvent } from '../domain/entities/zalo-webhook-event.types';
import { ZaloWebhookDispatchService } from './zalo-webhook-dispatch.service';

/** Stable per-delivery event id for the durable inbox. */
export function buildZaloEventId(event: ZaloWebhookEvent): string {
  if (event.message?.msg_id) {
    return event.message.msg_id;
  }
  const userId = event.sender?.id ?? event.follower?.id ?? 'unknown';
  return `${event.event_name}:${userId}:${event.timestamp ?? Date.now()}`;
}

/**
 * Durable ingestion for authenticated Zalo webhook events: persist before
 * acknowledging, process inline with a claim, and record failures for the
 * inbound retry cron. A persistence failure propagates so the endpoint
 * answers non-2xx (the event is never acknowledged unpersisted).
 */
@Injectable()
export class ZaloWebhookIngestService {
  private readonly logger = new Logger(ZaloWebhookIngestService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly dispatcher: ZaloWebhookDispatchService,
    private readonly inboundEvents: PlatformWebhookInboundEventService,
  ) {}

  async processEvent(body: ZaloWebhookEvent): Promise<void> {
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
      return;
    }

    // Claim before processing — the retry cron claims too, so an event is
    // never processed twice. If the cron grabbed it first, skip (it will
    // process the event on its tick).
    if (id !== undefined && !(await this.inboundEvents.claim(id))) {
      this.logger.debug(
        `Webhook event id=${maskEventId(
          eventId,
          externalUserId,
        )} already claimed — deferring to retry cron`,
      );
      return;
    }

    let processingError: unknown;
    try {
      await this.dispatcher.dispatch(body);
    } catch (error) {
      processingError = error;
    }

    if (processingError !== undefined) {
      const errorMessageValue = maskExternalIdInText(
        errorMessage(processingError),
        externalUserId,
      );
      this.logger.warn(
        `Webhook event failed — scheduled for retry: ${errorMessageValue}`,
      );
      if (id !== undefined) {
        await this.inboundEvents
          .markFailed(
            id,
            errorMessageValue,
            readInboundRetryConfig((key) =>
              this.configService.get<string>(key),
            ),
          )
          .catch((saveErr: unknown) => {
            this.logger.error(
              `Failed to record inbound event failure: ${errorMessage(saveErr)}`,
            );
          });
      }
      return;
    }

    // Completion is best-effort: side effects already ran, so a failure to
    // mark must NOT schedule a retry (it would re-execute the event).
    // The stale-`processing` recovery in the retry cron re-claims the row.
    if (id !== undefined) {
      await this.inboundEvents.markCompleted(id).catch((markErr: unknown) => {
        this.logger.error(
          `Failed to mark inbound event id=${id} completed: ${errorMessage(markErr)}`,
        );
      });
    }
  }
}
