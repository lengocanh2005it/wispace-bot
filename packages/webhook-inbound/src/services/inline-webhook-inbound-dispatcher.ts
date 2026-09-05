import { Logger } from '@nestjs/common';
import { Counter, Histogram } from 'prom-client';
import {
  errorMessage,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import type { Platform } from '@wispace/contracts';
import type {
  PlatformWebhookInboundEventService,
  InboundRetryConfig,
} from './platform-webhook-inbound-event.service';

const webhookInboundInlineAttemptsTotal = new Counter({
  name: 'webhook_inbound_inline_attempts_total',
  help: 'Inline processing attempts after ingest',
  labelNames: ['platform', 'outcome'] as const,
});
export const webhookInboundDispatchLagSeconds = new Histogram({
  name: 'webhook_inbound_dispatch_lag_seconds',
  help: 'Seconds from event ingest to first processing attempt',
  labelNames: ['platform', 'trigger'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 15, 30],
});

/** Callback signature for inline dispatch after ingest. */
export type InlineWebhookDispatcherCallback = (
  id: number,
  rawPayload: object,
  meta: { ingestedAt: Date; eventId: string; externalUserId: string },
) => void;

/** DI token for the inline dispatcher callback. */
export const TRY_INLINE_DISPATCHER = Symbol('TRY_INLINE_DISPATCHER');

/** Outcome of processing a single inbound event (used by both cron and inline). */
export type InboundDispatchOutcome =
  | 'completed'
  | 'failed'
  | 'abandoned'
  | 'lost';

export interface InlineWebhookInboundDispatcherOptions {
  processEvent: (rawPayload: object) => Promise<void>;
  retryConfig: InboundRetryConfig;
  concurrency?: number;
}

/**
 * Shared processing path for a claimed inbound event: call processEvent,
 * mark completed on success, mark failed (bounded backoff) on error,
 * mark processing-abandoned when the completion write itself fails.
 * Used by both the retry cron and the inline dispatcher.
 */
export async function processClaimedInboundRow(
  id: number,
  leaseToken: string,
  rawPayload: unknown,
  eventService: PlatformWebhookInboundEventService,
  processEvent: (rawPayload: object) => Promise<void>,
  retryConfig: InboundRetryConfig,
  externalUserId?: string | null,
): Promise<InboundDispatchOutcome> {
  try {
    await processEvent(rawPayload as object);
  } catch (error) {
    const masked = maskExternalIdInText(errorMessage(error), externalUserId);
    const marked = await eventService.markFailed(
      id,
      leaseToken,
      masked,
      retryConfig,
    );
    return marked ? 'failed' : 'lost';
  }

  try {
    const completed = await eventService.markCompleted(id, leaseToken);
    return completed ? 'completed' : 'lost';
  } catch (error) {
    const masked = maskExternalIdInText(errorMessage(error), externalUserId);
    await eventService.markProcessingAbandoned(id, leaseToken, masked);
    return 'abandoned';
  }
}

/**
 * Attempts inline processing of a freshly-ingested inbound event immediately
 * after ingest, without waiting for the retry cron. Fire-and-forget: errors
 * are logged and metered, never thrown. The retry cron remains the backstop.
 */
export class InlineWebhookInboundDispatcher {
  private readonly logger = new Logger(InlineWebhookInboundDispatcher.name);
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly eventService: PlatformWebhookInboundEventService,
    private readonly platform: Platform,
    private readonly options: InlineWebhookInboundDispatcherOptions,
  ) {}

  /**
   * Fire-and-forget inline processing. Caller does NOT await this.
   */
  tryInline(
    id: number,
    rawPayload: object,
    meta: { ingestedAt: Date; eventId?: string; externalUserId?: string },
  ): void {
    this.acquire()
      .then(async () => {
        const leaseToken = await this.eventService.claim(id);
        if (!leaseToken) {
          webhookInboundInlineAttemptsTotal.inc({
            platform: this.platform,
            outcome: 'lost',
          });
          return;
        }

        const lagSeconds = (Date.now() - meta.ingestedAt.getTime()) / 1000;
        webhookInboundDispatchLagSeconds.observe(
          { platform: this.platform, trigger: 'inline' },
          lagSeconds,
        );

        const outcome = await processClaimedInboundRow(
          id,
          leaseToken,
          rawPayload,
          this.eventService,
          this.options.processEvent,
          this.options.retryConfig,
          meta.externalUserId,
        );

        webhookInboundInlineAttemptsTotal.inc({
          platform: this.platform,
          outcome,
        });

        if (outcome !== 'completed') {
          this.logger.warn(`Inline dispatch id=${id} outcome=${outcome}`);
        }
      })
      .catch((error) => {
        this.logger.error(
          `Inline dispatch id=${id} crashed: ${errorMessage(error)}`,
        );
        webhookInboundInlineAttemptsTotal.inc({
          platform: this.platform,
          outcome: 'lost',
        });
      })
      .finally(() => this.release());
  }

  private async acquire(): Promise<void> {
    const max = this.options.concurrency ?? 5;
    if (this.running < max) {
      this.running += 1;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.running -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
