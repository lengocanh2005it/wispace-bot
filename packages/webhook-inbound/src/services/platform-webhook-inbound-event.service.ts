import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { Counter, Histogram } from 'prom-client';
import {
  errorMessage,
  maskExternalIdInText,
  truncatePersistedError,
} from '@wispace/bot-common/masking';
import { jitteredDelayMs } from '@wispace/bot-common/utils';

const webhookInboundRetentionDeletedTotal = new Counter({
  name: 'webhook_inbound_retention_deleted_total',
  help: 'Total rows deleted by webhook inbound retention cleanup',
});
const webhookInboundInlineAttemptsTotal = new Counter({
  name: 'webhook_inbound_inline_attempts_total',
  help: 'Inline processing attempts after ingest',
  labelNames: ['platform', 'outcome'] as const,
});
const webhookInboundDispatchLagSeconds = new Histogram({
  name: 'webhook_inbound_dispatch_lag_seconds',
  help: 'Seconds from event ingest to first processing attempt',
  labelNames: ['platform', 'trigger'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 15, 30],
});
import { WebhookInboundEventEntity } from '@wispace/database';
import type { Platform } from '@wispace/contracts';

export interface IngestInboundEventInput {
  eventId: string;
  externalUserId?: string | null;
  eventType?: string | null;
  rawPayload: object;
}

export interface IngestInboundEventResult {
  /** True when the event was newly stored (first delivery). */
  inserted: boolean;
  /** Row id of the stored event — present when `inserted` is true. */
  id?: number;
}

export interface InboundEventRow {
  id: number;
  platform: Platform;
  eventId: string;
  externalUserId: string | null;
  eventType: string | null;
  rawPayload: unknown;
  status: string;
  retryCount: number;
  nextRetryAt: Date | null;
  createdAt: Date;
}

/** Bounded retry/backoff configuration for inbound event processing. */
export interface InboundRetryConfig {
  maxRetries: number;
  baseRetryMs: number;
  capRetryMs: number;
  /** Injectable RNG for equal-jitter on `next_retry_at` — tests pass a stub,
   *  production leaves it undefined (`Math.random`). */
  rng?: () => number;
}

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_RETRY_MS = 60_000;
const DEFAULT_CAP_RETRY_MS = 8 * 60_000;

/** Read `WEBHOOK_INBOUND_*` envs with shared defaults (cron + request path). */
export function readInboundRetryConfig(
  get: (key: string) => string | undefined,
): InboundRetryConfig {
  return {
    maxRetries: readPositiveInt(
      get('WEBHOOK_INBOUND_MAX_RETRIES'),
      DEFAULT_MAX_RETRIES,
    ),
    baseRetryMs: readPositiveInt(
      get('WEBHOOK_INBOUND_BASE_RETRY_MS'),
      DEFAULT_BASE_RETRY_MS,
    ),
    capRetryMs: readPositiveInt(
      get('WEBHOOK_INBOUND_CAP_RETRY_MS'),
      DEFAULT_CAP_RETRY_MS,
    ),
  };
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Outcome of processing a single inbound event (used by both cron and inline). */
export type InboundDispatchOutcome =
  | 'completed'
  | 'failed'
  | 'abandoned'
  | 'lost';

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
): Promise<InboundDispatchOutcome> {
  try {
    await processEvent(rawPayload as object);
  } catch (error) {
    const masked = maskExternalIdInText(errorMessage(error));
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
    const masked = maskExternalIdInText(errorMessage(error));
    await eventService.markProcessingAbandoned(id, leaseToken, masked);
    return 'abandoned';
  }
}

/**
 * Durable inbox for authenticated inbound webhook events. `ingest` is the
 * write-ahead gate: the webhook endpoint only acknowledges an event after
 * it is persisted here. The unique `(platform, event_id)` constraint makes
 * duplicate deliveries idempotent (conflict ⇒ already stored ⇒ skip).
 */
@Injectable()
export class PlatformWebhookInboundEventService {
  constructor(
    private readonly platform: Platform,
    @InjectRepository(WebhookInboundEventEntity)
    private readonly repo: Repository<WebhookInboundEventEntity>,
  ) {}

  /**
   * Persist an inbound event before the webhook acknowledges it.
   * Returns `{ inserted: true, id }` for a first delivery, `{ inserted: false }`
   * for a duplicate. Throws when persistence itself fails — the caller must
   * NOT acknowledge (non-2xx so the platform redelivers).
   */
  async ingest(
    input: IngestInboundEventInput,
  ): Promise<IngestInboundEventResult> {
    const result = (await this.repo
      .createQueryBuilder()
      .insert()
      .into(WebhookInboundEventEntity)
      .values({
        platform: this.platform,
        eventId: input.eventId,
        externalUserId: input.externalUserId ?? null,
        eventType: input.eventType ?? null,
        rawPayload: input.rawPayload,
        status: 'pending',
        retryCount: 0,
      })
      .orIgnore()
      .returning('id')
      .execute()) as { raw?: Array<{ id: number }> };

    const inserted = result.raw;
    const id = inserted?.[0]?.id;
    return inserted !== undefined && inserted.length > 0
      ? { inserted: true, id }
      : { inserted: false };
  }

  /**
   * Mark an owned event completed. Requires the `leaseToken` returned by
   * `claim` and the row still being `processing` — a worker whose lease was
   * stale-recovered (or whose row was terminalized) no-ops instead of
   * overwriting the terminal state (#149).
   * Returns false when the ownership check failed.
   */
  async markCompleted(id: number, leaseToken: string): Promise<boolean> {
    return this.updateOwnedProcessing(id, leaseToken, {
      status: 'completed',
      lastError: null,
      nextRetryAt: null,
      processedAt: new Date(),
    });
  }

  /**
   * Atomically claim an event for processing: `pending`/`failed` → `processing`
   * with a fresh lease token. The retry worker claims before processing, so an
   * event can never be processed by two workers at once.
   * Returns the lease token when claimed; null when another worker already
   * claimed it.
   */
  async claim(id: number): Promise<string | null> {
    const leaseToken = randomUUID();
    const result = await this.repo
      .createQueryBuilder()
      .update(WebhookInboundEventEntity)
      .set({ status: 'processing', leaseToken })
      .where('id = :id', { id })
      .andWhere('status IN (:...statuses)', {
        statuses: ['pending', 'failed'],
      })
      .execute();

    return (result.affected ?? 0) > 0 ? leaseToken : null;
  }

  /**
   * Terminalize a processing lease that outlived the worker lease. Replaying
   * is intentionally avoided because outbound side effects may already have
   * happened before the worker crashed.
   */
  async abandonStaleProcessing(
    id: number,
    staleBefore: Date,
  ): Promise<boolean> {
    return this.terminalizeProcessing(
      id,
      'Processing lease expired; event was not replayed automatically to avoid duplicate side effects',
      'status = :status AND updated_at < :staleBefore',
      { status: 'processing', staleBefore },
    );
  }

  /**
   * Mark a claimed event terminal when its downstream side effect completed
   * but the completion write itself failed. This prevents an automatic retry
   * from duplicating an outbound message. Requires the lease token (#149).
   */
  async markProcessingAbandoned(
    id: number,
    leaseToken: string,
    errorMessage: string,
  ): Promise<boolean> {
    return this.terminalizeProcessing(
      id,
      errorMessage,
      'status = :status AND lease_token = :leaseToken',
      { status: 'processing', leaseToken },
    );
  }

  private async terminalizeProcessing(
    id: number,
    errorMessage: string,
    condition: string,
    parameters: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(WebhookInboundEventEntity)
      .set({
        status: 'abandoned',
        lastError: truncatePersistedError(maskExternalIdInText(errorMessage)),
        nextRetryAt: null,
        processedAt: new Date(),
      })
      .where('id = :id', { id })
      .andWhere(condition, parameters)
      .execute();

    return (result.affected ?? 0) > 0;
  }

  /**
   * Record a processing failure with bounded exponential backoff:
   * `next_retry_at = now + jitter(min(base * 2^(retry_count), cap))`, where
   * `jitter` is the shared equal-jitter policy (50–100% of nominal) so many
   * rows that failed on the same upstream error do not all become due in the
   * same cron tick (thundering herd).
   * When the retry budget is exhausted the event becomes `abandoned`
   * (terminal failure state). Requires the lease token — a stale worker
   * whose ownership was lost no-ops (#149). Returns false on no-op.
   */
  async markFailed(
    id: number,
    leaseToken: string,
    errorMessage: string,
    opts: InboundRetryConfig,
  ): Promise<boolean> {
    const row = await this.repo.findOne({
      select: { id: true, retryCount: true, externalUserId: true },
      where: { id },
    });
    const nextRetryCount = (row?.retryCount ?? 0) + 1;

    const cap = opts.capRetryMs;
    const nominalDelay = Math.min(
      opts.baseRetryMs * Math.pow(2, nextRetryCount - 1),
      cap,
    );
    const delay = jitteredDelayMs(nominalDelay, opts.rng);
    const nextRetryAt = new Date(Date.now() + delay);

    return this.updateOwnedProcessing(id, leaseToken, {
      status: nextRetryCount >= opts.maxRetries ? 'abandoned' : 'failed',
      retryCount: nextRetryCount,
      lastError: truncatePersistedError(
        maskExternalIdInText(errorMessage, row?.externalUserId),
      ),
      nextRetryAt: nextRetryCount >= opts.maxRetries ? null : nextRetryAt,
      processedAt: new Date(),
    });
  }

  /**
   * Applies a patch only while the caller still owns the `processing` lease
   * (id + lease token + status). Returns false when ownership was lost —
   * the stale worker must not overwrite a terminal/reclaimed state.
   */
  private async updateOwnedProcessing(
    id: number,
    leaseToken: string,
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(WebhookInboundEventEntity)
      .set(patch)
      .where('id = :id', { id })
      .andWhere('lease_token = :leaseToken', { leaseToken })
      .andWhere('status = :status', { status: 'processing' })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  /**
   * Retention cleanup for raw payloads: delete terminal rows
   * (`completed`/`abandoned`) older than `cutoff`. Non-terminal rows
   * (`pending`/`failed`/`processing`) are never touched — the durable inbox
   * recovery flow must keep working.
   */
  async deleteTerminalOlderThan(cutoff: Date): Promise<number> {
    const BATCH_SIZE = 1000;
    let totalDeleted = 0;

    for (;;) {
      const ids: Array<{ id: number }> = await this.repo.query(
        `SELECT id FROM webhook_inbound_events
         WHERE platform = $1 AND status IN ('completed','abandoned')
           AND created_at < $2
         LIMIT $3`,
        [this.platform, cutoff, BATCH_SIZE],
      );

      if (ids.length === 0) break;

      const result = await this.repo
        .createQueryBuilder()
        .delete()
        .from(WebhookInboundEventEntity)
        .where('id IN (:...ids)', { ids: ids.map((r) => r.id) })
        .execute();

      totalDeleted += result.affected ?? 0;

      if (ids.length < BATCH_SIZE) {
        break;
      }
    }

    if (totalDeleted > 0) {
      webhookInboundRetentionDeletedTotal.inc(totalDeleted);
    }

    return totalDeleted;
  }

  /**
   * Rows due for processing: never-processed (`pending`, no backoff gate)
   * or failed with `next_retry_at` in the past, or `processing` stuck longer
   * than `processingStuckMs` (crash between claim and mark). Bounded by `limit`.
   */
  async listDue(opts: {
    limit: number;
    now?: Date;
    processingStuckMs?: number;
  }): Promise<InboundEventRow[]> {
    const now = opts.now ?? new Date();
    const staleBefore = new Date(
      now.getTime() - (opts.processingStuckMs ?? 300_000),
    );

    const rows = await this.repo
      .createQueryBuilder('evt')
      .where('evt.platform = :platform', { platform: this.platform })
      .andWhere(
        `(
          evt.status IN (:...statuses)
          AND (evt.next_retry_at IS NULL OR evt.next_retry_at <= :now)
        )
        OR (evt.status = 'processing' AND evt.updated_at < :staleBefore)`,
        { statuses: ['pending', 'failed'], now, staleBefore },
      )
      .orderBy('evt.id', 'ASC')
      .limit(opts.limit)
      .getMany();

    return rows.map((row) => ({
      id: row.id,
      platform: row.platform,
      eventId: row.eventId,
      externalUserId: row.externalUserId,
      eventType: row.eventType,
      rawPayload: row.rawPayload,
      status: row.status,
      retryCount: row.retryCount,
      nextRetryAt: row.nextRetryAt,
      createdAt: row.createdAt,
    }));
  }

  /**
   * Total rows matching the `listDue` predicate — the backlog
   * measure for monitoring; `listDue` itself stays capped by `limit`.
   * Capped at 10 000 to avoid unbounded COUNT(*) scans (#160).
   */
  async countDue(opts: {
    now?: Date;
    processingStuckMs?: number;
  }): Promise<number> {
    const now = opts.now ?? new Date();
    const staleBefore = new Date(
      now.getTime() - (opts.processingStuckMs ?? 300_000),
    );

    // Bounded count: LIMIT stops the index scan after 10 001 matching rows
    // so query work stays O(1) even when the inbox grows large (#272).
    const rows: Array<{ count: string }> = await this.repo.query(
      `
      SELECT COUNT(*)::text AS count
      FROM (
        SELECT 1
        FROM webhook_inbound_events
        WHERE platform = $1
          AND (
            (status IN ('pending', 'failed') AND (next_retry_at IS NULL OR next_retry_at <= $2))
            OR (status = 'processing' AND updated_at < $3)
          )
        LIMIT 10001
      ) sub
      `,
      [this.platform, now, staleBefore],
    );

    return Number(rows[0]?.count ?? 0);
  }
}

export interface InlineWebhookInboundDispatcherOptions {
  processEvent: (rawPayload: object) => Promise<void>;
  retryConfig: InboundRetryConfig;
  concurrency?: number;
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
