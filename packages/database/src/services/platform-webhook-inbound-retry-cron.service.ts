import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { errorMessage, PgAdvisoryLockService } from '@wispace/bot-common';
import {
  PlatformWebhookInboundEventService,
  readInboundRetryConfig,
} from './platform-webhook-inbound-event.service';

const DEFAULT_RETRY_LIMIT = 20;

export interface WebhookInboundRetryCronOptions {
  /** Advisory lock id — only one pod retries the inbox per tick. */
  lockId: number;
  /** Re-process a stored event (route/execute like a fresh delivery). */
  processEvent: (rawPayload: object) => Promise<void>;
}

/**
 * Retries due inbound webhook events from the durable inbox
 * (`webhook_inbound_events`): `pending` rows (crash between ingest and
 * processing) and `failed` rows whose backoff has elapsed. Every run is
 * claim-based and advisory-locked (multi-pod safe). Processing retries use
 * bounded exponential backoff; after `maxRetries` failures the event is
 * marked `abandoned` — the terminal failure state.
 */
@Injectable()
export class PlatformWebhookInboundRetryCronService {
  private readonly logger = new Logger(
    PlatformWebhookInboundRetryCronService.name,
  );

  constructor(
    private readonly inboundEvents: PlatformWebhookInboundEventService,
    private readonly configService: ConfigService,
    private readonly pgLock: PgAdvisoryLockService,
    private readonly options: WebhookInboundRetryCronOptions,
  ) {}

  @Cron('*/30 * * * * *')
  async handleRetry(): Promise<void> {
    const result = await this.pgLock.withLock(this.options.lockId, () =>
      this.runRetryBatch(),
    );

    if (result === null) {
      this.logger.debug(
        'webhook-inbound-retry skipped — lock held by another pod',
      );
    }
  }

  private async runRetryBatch(): Promise<void> {
    const retryConfig = readInboundRetryConfig((key) =>
      this.configService.get<string>(key),
    );
    const retryLimit = this.readPositiveInt(
      'WEBHOOK_INBOUND_RETRY_LIMIT',
      DEFAULT_RETRY_LIMIT,
    );

    const rows = await this.inboundEvents.listDue({ limit: retryLimit });
    if (rows.length === 0) {
      return;
    }

    this.logger.log(`Inbound retry: processing ${rows.length} event(s)`);

    let completed = 0;
    let failed = 0;
    let abandoned = 0;

    for (const row of rows) {
      try {
        await this.options.processEvent(row.rawPayload as object);
        await this.inboundEvents.markCompleted(row.id);
        completed += 1;
        this.logger.log(
          `Inbound event id=${row.id} eventId=${row.eventId} processed successfully`,
        );
      } catch (error) {
        const errorMsg = errorMessage(error);
        const nextRetryCount = row.retryCount + 1;

        await this.inboundEvents.markFailed(row.id, errorMsg, retryConfig);

        if (nextRetryCount >= retryConfig.maxRetries) {
          abandoned += 1;
          this.logger.warn(
            `Inbound event id=${row.id} eventId=${row.eventId} abandoned after ${retryConfig.maxRetries} attempts: ${errorMsg}`,
          );
        } else {
          failed += 1;
          this.logger.warn(
            `Inbound event id=${row.id} eventId=${row.eventId} retry ${nextRetryCount}/${retryConfig.maxRetries} failed: ${errorMsg}`,
          );
        }
      }
    }

    this.logger.log(
      `Inbound retry done: completed=${completed}, failed=${failed}, abandoned=${abandoned}`,
    );
  }

  private readPositiveInt(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }
}
