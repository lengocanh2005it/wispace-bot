import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import {
  errorMessage,
  maskEventId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import { runLockedTick } from '@wispace/bot-common/cron';
import type { LockedTickItem } from '@wispace/bot-common/cron';
import { readEnvPositiveInt } from '@wispace/bot-common/config';
import { runBatched } from '@wispace/scheduler-core/core';
import {
  PlatformWebhookInboundEventService,
  readInboundRetryConfig,
  type InboundEventRow,
} from '../adapters/platform-webhook-inbound-event.service';
import { webhookInboundDispatchLagSeconds } from './inline-webhook-inbound-dispatcher';

const DEFAULT_RETRY_LIMIT = 20;
const DEFAULT_RETRY_CONCURRENCY = 5;
const DEFAULT_PROCESSING_STUCK_MS = 5 * 60_000;

export interface InboundRetryStats {
  /** Rows claimed/processed this tick (capped by WEBHOOK_INBOUND_RETRY_LIMIT). */
  due: number;
  /** Total due rows including those beyond this tick's limit — backlog signal. */
  backlog: number;
  completed: number;
  failed: number;
  abandoned: number;
  skipped: number;
}

type InboundRetryItemDetail = 'completed' | 'failed' | 'abandoned' | 'skipped';

export interface WebhookInboundRetryCronOptions {
  /** Advisory lock id — only one pod retries the inbox per tick. */
  lockId: number;
  /** Re-process a stored event (route/execute like a fresh delivery). */
  processEvent: (rawPayload: object) => Promise<void>;
  /** Optional per-tick stats hook — e.g. a Prometheus backlog gauge. */
  onTickComplete?: (stats: InboundRetryStats) => void;
  /** Optional Prometheus heartbeat adapter, kept structural to avoid a package cycle. */
  metrics?: {
    registerCron(name: string, expectedIntervalMs: number): void;
    recordCronSuccess(name: string): void;
  };
  /** Stable per-platform metric label/name for the retry cron. */
  cronName?: string;
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
  ) {
    if (options.metrics && options.cronName) {
      options.metrics.registerCron(options.cronName, 30 * 1000);
    }
  }

  @Cron('*/30 * * * * *')
  async handleRetry(): Promise<void> {
    await runLockedTick({
      name: this.options.cronName ?? 'webhook-inbound-retry',
      withLock: (run) => this.pgLock.withLock(this.options.lockId, run),
      run: () => this.runRetryBatch(),
      metrics:
        this.options.metrics && this.options.cronName
          ? this.options.metrics
          : undefined,
      logger: this.logger,
    });
  }

  private async runRetryBatch(): Promise<
    LockedTickItem<InboundRetryItemDetail>[]
  > {
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
    // Unbounded backlog (listDue is capped by retryLimit) — the metric that
    // reveals a backlog growing faster than recovery.
    const backlog = await this.inboundEvents.countDue({ processingStuckMs });
    const stats: InboundRetryStats = {
      due: rows.length,
      backlog,
      completed: 0,
      failed: 0,
      abandoned: 0,
      skipped: 0,
    };
    if (rows.length === 0) {
      this.options.onTickComplete?.(stats);
      return [];
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
    return results.map((result) =>
      result.status === 'fulfilled'
        ? result.value
        : { outcome: 'failed' as const, details: 'failed' as const },
    );
  }

  private async processRow(
    row: InboundEventRow,
    retryConfig: ReturnType<typeof readInboundRetryConfig>,
    staleBefore: Date,
    stats: InboundRetryStats,
  ): Promise<LockedTickItem<InboundRetryItemDetail>> {
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
        return { outcome: 'succeeded', details: 'abandoned' };
      } else {
        stats.skipped += 1;
        return { outcome: 'skipped', details: 'skipped' };
      }
    }

    // The retry worker claims before processing, so one row is handled by
    // only one retry worker at a time (parallel batches claim disjoint rows).
    // The lease token returned by the claim must accompany every state
    // transition — a stale worker whose lease was recovered no-ops (#149).
    const leaseToken = await this.inboundEvents.claim(row.id);
    if (!leaseToken) {
      stats.skipped += 1;
      return { outcome: 'skipped', details: 'skipped' };
    }

    const lagSeconds = (Date.now() - row.createdAt.getTime()) / 1000;
    webhookInboundDispatchLagSeconds.observe(
      { platform: row.platform, trigger: 'cron' },
      lagSeconds,
    );

    try {
      await this.options.processEvent(row.rawPayload as object);
    } catch (error) {
      const errorMsg = maskExternalIdInText(
        errorMessage(error),
        row.externalUserId,
      );
      const nextRetryCount = row.retryCount + 1;
      const maskedEventId = maskEventId(row.eventId, row.externalUserId);

      const marked = await this.inboundEvents.markFailed(
        row.id,
        leaseToken,
        errorMsg,
        retryConfig,
      );
      if (!marked) {
        stats.skipped += 1;
        return { outcome: 'skipped', details: 'skipped' };
      }

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
      return {
        outcome: 'succeeded',
        details:
          nextRetryCount >= retryConfig.maxRetries ? 'abandoned' : 'failed',
      };
    }

    try {
      const completed = await this.inboundEvents.markCompleted(
        row.id,
        leaseToken,
      );
      if (!completed) {
        stats.skipped += 1;
        return { outcome: 'skipped', details: 'skipped' };
      }
      stats.completed += 1;
      this.logger.log(
        `Inbound event id=${row.id} eventId=${maskEventId(
          row.eventId,
          row.externalUserId,
        )} processed successfully`,
      );
      return { outcome: 'succeeded', details: 'completed' };
    } catch (error) {
      const completionError = maskExternalIdInText(
        errorMessage(error),
        row.externalUserId,
      );
      const terminalized = await this.inboundEvents.markProcessingAbandoned(
        row.id,
        leaseToken,
        completionError,
      );
      if (terminalized) {
        stats.abandoned += 1;
        this.logger.error(
          `Inbound event id=${row.id} completion failed; automatic replay skipped: ${completionError}`,
        );
        return { outcome: 'succeeded', details: 'abandoned' };
      } else {
        stats.skipped += 1;
        return { outcome: 'skipped', details: 'skipped' };
      }
    }
  }

  private readPositiveInt(key: string, fallback: number): number {
    return readEnvPositiveInt(this.configService, key, fallback);
  }
}
