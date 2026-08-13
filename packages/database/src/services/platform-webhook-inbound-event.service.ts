import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { maskExternalIdInText } from '@wispace/bot-common';
import { WebhookInboundEventEntity } from '../entities/webhook-inbound-event.entity';
import type { Platform } from '../types';

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
}

/** Bounded retry/backoff configuration for inbound event processing. */
export interface InboundRetryConfig {
  maxRetries: number;
  baseRetryMs: number;
  capRetryMs: number;
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

  async markCompleted(id: number): Promise<void> {
    await this.repo.update(id, {
      status: 'completed',
      lastError: null,
      nextRetryAt: null,
      processedAt: new Date(),
    });
  }

  /**
   * Atomically claim an event for processing: `pending`/`failed` → `processing`.
   * Both the request path (right after ingest) and the retry cron claim before
   * processing, so an event can never be processed by two workers at once.
   * Returns `false` when another worker already claimed it.
   */
  async claim(id: number): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(WebhookInboundEventEntity)
      .set({ status: 'processing' })
      .where('id = :id', { id })
      .andWhere('status IN (:...statuses)', {
        statuses: ['pending', 'failed'],
      })
      .execute();

    return (result.affected ?? 0) > 0;
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
    const result = await this.repo
      .createQueryBuilder()
      .update(WebhookInboundEventEntity)
      .set({
        status: 'abandoned',
        lastError:
          'Processing lease expired; event was not replayed automatically to avoid duplicate side effects',
        nextRetryAt: null,
        processedAt: new Date(),
      })
      .where('id = :id', { id })
      .andWhere('status = :status AND updated_at < :staleBefore', {
        status: 'processing',
        staleBefore,
      })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  /**
   * Mark a claimed event terminal when its downstream side effect completed
   * but the completion write itself failed. This prevents an automatic retry
   * from duplicating an outbound message.
   */
  async markProcessingAbandoned(
    id: number,
    errorMessage: string,
  ): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(WebhookInboundEventEntity)
      .set({
        status: 'abandoned',
        lastError: errorMessage,
        nextRetryAt: null,
        processedAt: new Date(),
      })
      .where('id = :id', { id })
      .andWhere('status = :status', { status: 'processing' })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  /**
   * Record a processing failure with bounded exponential backoff:
   * `next_retry_at = now + min(base * 2^(retry_count), cap)`.
   * When the retry budget is exhausted the event becomes `abandoned`
   * (terminal failure state).
   */
  async markFailed(
    id: number,
    errorMessage: string,
    opts: InboundRetryConfig,
  ): Promise<void> {
    const row = await this.repo.findOne({
      select: { id: true, retryCount: true, externalUserId: true },
      where: { id },
    });
    const nextRetryCount = (row?.retryCount ?? 0) + 1;

    const cap = opts.capRetryMs;
    const delay = Math.min(
      opts.baseRetryMs * Math.pow(2, nextRetryCount - 1),
      cap,
    );
    const nextRetryAt = new Date(Date.now() + delay);

    await this.repo.update(id, {
      status: nextRetryCount >= opts.maxRetries ? 'abandoned' : 'failed',
      retryCount: nextRetryCount,
      lastError: maskExternalIdInText(errorMessage, row?.externalUserId),
      nextRetryAt: nextRetryCount >= opts.maxRetries ? null : nextRetryAt,
      processedAt: new Date(),
    });
  }

  /**
   * Retention cleanup for raw payloads: delete terminal rows
   * (`completed`/`abandoned`) older than `cutoff`. Non-terminal rows
   * (`pending`/`failed`/`processing`) are never touched — the durable inbox
   * recovery flow must keep working.
   */
  async deleteTerminalOlderThan(cutoff: Date): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .from(WebhookInboundEventEntity)
      .where('platform = :platform', { platform: this.platform })
      .andWhere('status IN (:...statuses)', {
        statuses: ['completed', 'abandoned'],
      })
      .andWhere('created_at < :cutoff', { cutoff })
      .execute();

    return result.affected ?? 0;
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
    }));
  }
}
