import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pLimit from 'p-limit';
import { maskEventId } from '@wispace/bot-common/masking';
import { TRY_INLINE_DISPATCHER } from '@wispace/webhook-inbound';
import { WEBHOOK_INBOUND_EVENTS_PORT } from '../../domain/repositories/webhook-inbound-events.port';
import type { WebhookInboundEventsPort } from '../../domain/repositories/webhook-inbound-events.port';
import {
  MessengerWebhookEvent,
  MessengerWebhookPayload,
} from '../../domain/entities/messenger.types';
import { buildEventId } from './messenger-event-id';

export { MessengerApiError } from './messenger-outbound.service';
// Re-exported so the event-id contract keeps one import path. The
// implementation moved beside `MessengerWebhookDispatchService`, which is the
// only other consumer.
export {
  buildEventId,
  buildIdempotencyKey,
  MAX_EVENT_ID_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from './messenger-event-id';

function buildEventType(event: MessengerWebhookEvent): string {
  if (event.postback) return 'postback';
  if (event.message) return 'message';
  if (event.referral) return 'referral';
  if (event.optin) return 'optin';
  return 'unsupported';
}

@Injectable()
export class MessengerService {
  private readonly logger = new Logger(MessengerService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(WEBHOOK_INBOUND_EVENTS_PORT)
    private readonly inboundEvents: WebhookInboundEventsPort,
    @Optional()
    @Inject(TRY_INLINE_DISPATCHER)
    private readonly tryInlineDispatcher?:
      | ((
          id: number,
          rawPayload: object,
          meta: { ingestedAt: Date; eventId: string; externalUserId: string },
        ) => void)
      | null,
  ) {}

  verifyWebhook(token?: string, challenge?: string): string {
    if (token !== this.configService.get<string>('VERIFY_TOKEN')) {
      throw new ForbiddenException('Invalid verify token');
    }

    return challenge ?? '';
  }

  /**
   * Durable ingestion: every authenticated event is persisted to the inbox
   * (`webhook_inbound_events`) BEFORE acknowledging. Downstream processing is
   * owned by the retry cron after the endpoint returns. A duplicate delivery
   * is skipped (idempotent), and a persistence failure propagates so the
   * endpoint answers non-2xx and the platform redelivers.
   */
  async handleWebhook(payload: MessengerWebhookPayload): Promise<{
    accepted: number;
    duplicates: number;
  }> {
    // Count entries BEFORE flatten to reject oversized batches early (#365).
    // The boundary mapper permits up to 50 entries × 500 events, but the
    // service default accepts only 50 total events. Reject before per-event
    // logging or construction of the full ingestion work list.
    const maxBatchSize = this.configService.get<number>(
      'WEBHOOK_MAX_BATCH_SIZE',
      50,
    );
    let totalEventCount = 0;
    for (const entry of payload.entry) {
      totalEventCount += entry.messaging.length;
    }
    if (totalEventCount > maxBatchSize) {
      this.logger.warn(
        `Webhook batch rejected: ${totalEventCount} events exceeds limit ${maxBatchSize}`,
      );
      throw new PayloadTooLargeException(
        `Batch size ${totalEventCount} exceeds limit ${maxBatchSize}`,
      );
    }

    // Flatten all events from the batch for parallel ingestion (#155).
    const events: Array<{
      event: MessengerWebhookEvent;
      eventId: string;
    }> = [];

    for (const entry of payload.entry) {
      for (const event of entry.messaging) {
        this.logIncomingWebhookEvent(event);
        const eventId = buildEventId(event, event.sender?.id ?? '');
        events.push({ event, eventId });
      }
    }

    if (events.length === 0) {
      return { accepted: 0, duplicates: 0 };
    }

    // Bounded parallel insert — unique constraint handles idempotency.
    // p-limit caps concurrent DB inserts; Promise.allSettled processes all events.
    const limit = pLimit(5);
    const results = await Promise.allSettled(
      events.map(({ event, eventId }) =>
        limit(() =>
          this.inboundEvents
            .ingest({
              eventId,
              externalUserId: event.sender?.id ?? null,
              eventType: buildEventType(event),
              rawPayload: event,
            })
            .then((result) => ({
              eventId,
              rawPayload: event,
              ...result,
            })),
        ),
      ),
    );

    let accepted = 0;
    let duplicates = 0;
    const failures: string[] = [];

    for (const result of results) {
      if (result.status === 'rejected') {
        failures.push(String(result.reason));
        continue;
      }
      if (!result.value.inserted) {
        duplicates += 1;
        this.logger.debug(
          `Skipping duplicate webhook event id=${maskEventId(
            result.value.eventId,
            undefined,
          )}`,
        );
        continue;
      }
      accepted += 1;

      if (this.tryInlineDispatcher) {
        const raw = result.value.rawPayload as MessengerWebhookEvent;
        this.tryInlineDispatcher(result.value.id!, raw as object, {
          ingestedAt: new Date(),
          eventId: result.value.eventId,
          externalUserId: raw.sender?.id ?? '',
        });
      }
    }

    if (failures.length > 0) {
      this.logger.error(
        `Webhook ingestion: ${failures.length}/${events.length} events failed to persist`,
      );
      // Propagate so the endpoint returns non-2xx and Meta redelivers.
      throw new Error(
        `Webhook ingestion failed: ${failures.length}/${events.length} events`,
      );
    }

    return { accepted, duplicates };
  }

  private logIncomingWebhookEvent(event: MessengerWebhookEvent): void {
    const eventTypes = [
      event.optin ? 'optin' : null,
      event.postback ? 'postback' : null,
      event.message ? 'message' : null,
      event.referral ? 'referral' : null,
    ].filter(Boolean);

    this.logger.log(`Webhook event: ${eventTypes.join(', ') || 'unknown'}`);
  }
}
