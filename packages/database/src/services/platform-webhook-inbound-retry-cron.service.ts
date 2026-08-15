import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import {
  errorMessage,
  maskEventId,
  maskExternalIdInText,
  PgAdvisoryLockService,
} from '@wispace/bot-common';
import { runBatched } from '@wispace/scheduler-core';
import {
  PlatformWebhookInboundEventService,
  readInboundRetryConfig,
  type InboundEventRow,
} from './platform-webhook-inbound-event.service';

const DEFAULT_RETRY_LIMIT = 20;
const DEFAULT_RETRY_CONCURRENCY = 5;
const DEFAULT_PROCESSING_STUCK_MS = 5 * 60_000;

export interface InboundRetryStats {
  due: number;
  completed: number;
  failed: number;
  abandoned: number;
  skipped: number;
}

export interface WebhookInboundRetryCronOptions {
  /** Advisory lock id — only one pod retries the inbox per tick. */
  lockId: number;
  /** Re-process a stored event (route/execute like a fresh delivery). */
  processEvent: (rawPayload: object) => Promise<void>;
  /** Optional per-tick stats hook — e.g. a Prometheus backlog gauge. */
  onTickComplete?: (stats: InboundRetryStats) => void;
}

/**
 * Retries due inbound webhook events from the durable inbox
 * (`webhook_inbound_events`): `pending` rows (crash between ingest and
 * processing) and `failed` rows whose backoff has elapsed. Stale
 * `processing` rows are terminalized without replay because their side
 * effects may already have completed. Every run is claim-based and
 * advisory-locked (multi-pod safe). Rows are claimed first and then
 * processed with bounded parallelism so a slow LLM or provider outage does
 * not make the 30-second retry cadence fall behind indefinitely. Processing
 * retries use bounded exponential backoff; after `maxRetries` failures the
 * event is marked `abandoned` — the terminal failure state.
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
    const processingStuckMs = this.readPositiveInt(
      'WEBHOOK_INBOUND_PROCESSING_STUCK_MS',
      DEFAULT_PROCESSING_STUCK_MS,
    );
    const concurrency = this.readPositiveInt(
      'WEBHOOK_INBOUND_RETRY_CONCURRENCY',
      DEFAULT_RETRY_CONCURRENCY,
    );

    const rows = await this.inboundEvents.listDue({
      limit: retryLimit,
      processingStuckMs,
    });
    const stats: InboundRetryStats = {
      due: rows.length,
      completed: 0,
      failed: 0,
      abandoned: 0,
      skipped: 0,
    };
    if (rows.length === 0) {
      this.options.onTickComplete?.(stats);
      return;
    }

    this.logger.log(`Inbound retry: processing ${rows.length} event(s)`);

    const staleBefore = new Date(Date.now() - processingStuckMs);

    // Claim-then-process: the per-row claim keeps one-owner status
    // transitions, then processing runs with bounded parallelism.
    const results = await runBatched(rows, concurrency, (row) =>
      this.processRow(row, retryConfig, staleBefore, stats),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        stats.skipped += 1;
      }
    }

    this.logger.log(
      `Inbound retry done: completed=${stats.completed}, failed=${stats.failed}, abandoned=${stats.abandoned}, skipped=${stats.skipped}`,
    );

    this.options.onTickComplete?.(stats);
  }

  private async processRow(
    row: InboundEventRow,
    retryConfig: ReturnType<typeof readInboundRetryConfig>,
    staleBefore: Date,
    stats: InboundRetryStats,
  ): Promise<void> {
    if (row.status === 'processing') {
      const terminalized = await this.inboundEvents.abandonStaleProcessing(
        row.id,
        staleBefore,
      );
      if (terminalized) {
        stats.abandoned += 1;
        this.logger.warn(
          `Inbound event id=${row.id} eventId=${maskEventId(
            row.eventId,
            row.externalUserId,
          )} abandoned after stale processing lease; automatic replay skipped`,
        );
      } else {
        stats.skipped += 1;
      }
      return;
    }

    // The retry worker claims before processing, so one row is handled by
    // only one retry worker at a time (parallel batches claim disjoint rows).
    const claimed = await this.inboundEvents.claim(row.id);
    if (!claimed) {
      stats.skipped += 1;
      return;
    }

    try {
      await this.options.processEvent(row.rawPayload as object);
    } catch (error) {
      const errorMsg = maskExternalIdInText(
        errorMessage(error),
        row.externalUserId,
      );
      const nextRetryCount = row.retryCount + 1;
      const maskedEventId = maskEventId(row.eventId, row.externalUserId);

      await this.inboundEvents.markFailed(row.id, errorMsg, retryConfig);

      if (nextRetryCount >= retryConfig.maxRetries) {
        stats.abandoned += 1;
        this.logger.warn(
          `Inbound event id=${row.id} eventId=${maskedEventId} abandoned after ${retryConfig.maxRetries} attempts: ${errorMsg}`,
        );
      } else {
        stats.failed += 1;
        this.logger.warn(
          `Inbound event id=${row.id} eventId=${maskedEventId} retry ${nextRetryCount}/${retryConfig.maxRetries} failed: ${errorMsg}`,
        );
      }
      return;
    }

    try {
      await this.inboundEvents.markCompleted(row.id);
      stats.completed += 1;
      this.logger.log(
        `Inbound event id=${row.id} eventId=${maskEventId(
          row.eventId,
          row.externalUserId,
        )} processed successfully`,
      );
    } catch (error) {
      const completionError = maskExternalIdInText(
        errorMessage(error),
        row.externalUserId,
      );
      const terminalized = await this.inboundEvents.markProcessingAbandoned(
        row.id,
        completionError,
      );
      if (terminalized) {
        stats.abandoned += 1;
      } else {
        stats.skipped += 1;
      }
      this.logger.error(
        `Inbound event id=${row.id} eventId=${maskEventId(
          row.eventId,
          row.externalUserId,
        )} completion failed; automatic replay skipped: ${completionError}`,
      );
    }
  }

  private readPositiveInt(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }
}
