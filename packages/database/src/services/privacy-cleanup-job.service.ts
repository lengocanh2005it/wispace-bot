import { createHash, randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import type { Platform } from '@wispace/contracts';
import { extractQueryRows, jitteredDelayMs } from '@wispace/bot-common/utils';

export const PRIVACY_CLEANUP_STORES = [
  'chat_history',
  'chat_queue',
  'clarification_state',
  'display_name_cache',
] as const;

export type PrivacyCleanupStore = (typeof PRIVACY_CLEANUP_STORES)[number];
export type PrivacyCleanupOperation = 'unlink' | 'delete';
export type PrivacyCleanupJobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'stale';

export const PRIVACY_CLEANUP_REQUEST_ATTEMPTS = 3;
export const PRIVACY_CLEANUP_WORKER_BATCH_SIZE = 100;
export const PRIVACY_CLEANUP_WORKER_LEASE_MS = 60_000;
export const PRIVACY_CLEANUP_RETENTION_DAYS = 7;
export const PRIVACY_CLEANUP_MAX_BACKOFF_MS = 15 * 60_000;

export interface PrivacyCleanupJobInput {
  operation: PrivacyCleanupOperation;
  platform: Platform;
  externalUserId: string;
  userId?: number;
  mappingGeneration: string;
  stores: readonly PrivacyCleanupStore[];
}

export interface PrivacyCleanupJobRef {
  cleanupId: string;
  idempotencyKey: string;
  store: PrivacyCleanupStore;
  id?: string;
  /** Last persisted failure count, used to continue exponential backoff. */
  attemptCount?: number;
}

export interface PrivacyCleanupJobRow extends PrivacyCleanupJobRef {
  operation: PrivacyCleanupOperation;
  platform: Platform;
  externalUserId: string;
  userId?: number;
  mappingGeneration: string;
  status: PrivacyCleanupJobStatus;
  attemptCount: number;
  nextRetryAt?: Date;
  leaseToken?: string;
  leaseExpiresAt?: Date;
  lastError?: string;
}

export interface PrivacyCleanupSummary {
  pendingCount: number;
  processingCount: number;
  retryingCount: number;
  oldestPendingAgeSeconds: number | null;
}

export interface PrivacyCleanupMetrics {
  incPrivacyCleanupAttempt(
    platform: Platform,
    operation: PrivacyCleanupOperation,
    store: PrivacyCleanupStore,
    outcome: 'success' | 'failure' | 'stale' | 'skipped',
  ): void;
  setPrivacyCleanupPending(
    platform: Platform,
    count: number,
    oldestAgeSeconds: number | null,
  ): void;
}

type Queryable = Pick<DataSource, 'query'>;

/**
 * Small SQL-backed store shared by the request path and platform workers.
 * The fallback map only keeps unit tests useful when no database table is
 * present; production always uses the additive migration-backed table.
 */
@Injectable()
export class PrivacyCleanupJobStore {
  private readonly fallback = new Map<string, PrivacyCleanupJobRow>();
  private readonly fallbackEnabled: boolean;

  constructor(@InjectDataSource() private readonly dataSource: Queryable) {
    // Production always supplies a TypeORM DataSource. Keep the in-memory
    // fallback strictly for lightweight query-only unit doubles so durable
    // identities do not accumulate in a process-local map after retention.
    this.fallbackEnabled = !('manager' in dataSource);
  }

  static cleanupId(input: Omit<PrivacyCleanupJobInput, 'stores'>): string {
    return createHash('sha256')
      .update(
        [
          input.operation,
          input.platform,
          input.externalUserId,
          input.mappingGeneration,
        ].join('\0'),
      )
      .digest('hex')
      .slice(0, 32);
  }

  async enqueue(
    manager: Pick<EntityManager, 'query'>,
    input: PrivacyCleanupJobInput,
  ): Promise<PrivacyCleanupJobRef[]> {
    const cleanupId = PrivacyCleanupJobStore.cleanupId(input);
    const refs: PrivacyCleanupJobRef[] = [];
    for (const store of input.stores) {
      const idempotencyKey = `${cleanupId}:${store}`;
      const rows = extractQueryRows<{
        id?: string | number;
        status?: PrivacyCleanupJobStatus;
      }>(
        await manager.query(
          `INSERT INTO privacy_cleanup_jobs
            (cleanup_id, idempotency_key, operation, platform, external_user_id,
             user_id, mapping_generation, store, status, attempt_count, next_retry_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 0, now())
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id, status`,
          [
            cleanupId,
            idempotencyKey,
            input.operation,
            input.platform,
            input.externalUserId,
            input.userId ?? null,
            input.mappingGeneration,
            store,
          ],
        ),
      );
      const id = rows[0]?.id;
      const existing = this.fallbackEnabled
        ? this.fallback.get(idempotencyKey)
        : undefined;
      if (this.fallbackEnabled && !existing) {
        this.fallback.set(idempotencyKey, {
          cleanupId,
          idempotencyKey,
          operation: input.operation,
          platform: input.platform,
          externalUserId: input.externalUserId,
          ...(input.userId === undefined ? {} : { userId: input.userId }),
          mappingGeneration: input.mappingGeneration,
          store,
          status: rows[0]?.status ?? 'pending',
          attemptCount: 0,
          ...(id === undefined ? {} : { id: String(id) }),
        });
      }
      refs.push({
        cleanupId,
        idempotencyKey,
        store,
        attemptCount: existing?.attemptCount ?? 0,
        ...(id === undefined
          ? existing?.id
            ? { id: existing.id }
            : {}
          : { id: String(id) }),
      });
    }
    return refs;
  }

  async getByCleanupId(
    cleanupId: string,
    platform: Platform,
  ): Promise<PrivacyCleanupJobRow[]> {
    const rows = (await this.query(
      `SELECT id, cleanup_id, idempotency_key, operation, platform,
              external_user_id, user_id, mapping_generation, store, status,
              attempt_count, next_retry_at, lease_token, lease_expires_at,
              last_error
         FROM privacy_cleanup_jobs
        WHERE cleanup_id = $1 AND platform = $2
        ORDER BY store`,
      [cleanupId, platform],
    )) as Array<Record<string, unknown>>;
    if (rows.length > 0) return rows.map(toJobRow);
    return this.fallbackEnabled
      ? [...this.fallback.values()].filter(
          (row) => row.cleanupId === cleanupId && row.platform === platform,
        )
      : [];
  }

  async markCompleted(
    ref: Pick<PrivacyCleanupJobRef, 'idempotencyKey'>,
    leaseToken?: string,
  ): Promise<void> {
    const params: unknown[] = [ref.idempotencyKey];
    const leasePredicate = leaseToken ? ` AND lease_token = $2` : '';
    if (leaseToken) params.push(leaseToken);
    await this.query(
      `UPDATE privacy_cleanup_jobs
          SET status = 'completed', completed_at = now(), updated_at = now(),
              lease_token = NULL, lease_expires_at = NULL
        WHERE idempotency_key = $1
          AND status IN ('pending', 'processing')${leasePredicate}`,
      params,
    );
    const row = this.fallbackEnabled
      ? this.fallback.get(ref.idempotencyKey)
      : undefined;
    if (row) {
      row.status = 'completed';
      row.leaseToken = undefined;
      row.leaseExpiresAt = undefined;
    }
  }

  async markFailure(
    ref: Pick<PrivacyCleanupJobRef, 'idempotencyKey' | 'attemptCount'>,
    error: string,
    leaseToken?: string,
    now = new Date(),
  ): Promise<void> {
    const current = this.fallbackEnabled
      ? this.fallback.get(ref.idempotencyKey)
      : undefined;
    const attempts = (ref.attemptCount ?? current?.attemptCount ?? 0) + 1;
    const backoff = Math.min(
      PRIVACY_CLEANUP_MAX_BACKOFF_MS,
      30_000 * 2 ** Math.min(attempts - 1, 8),
    );
    const nextRetryAt = new Date(now.getTime() + jitteredDelayMs(backoff));
    const params: unknown[] = [
      ref.idempotencyKey,
      nextRetryAt,
      error.slice(0, 160),
    ];
    let leasePredicate = '';
    if (leaseToken) {
      params.push(leaseToken);
      leasePredicate = ` AND lease_token = $${params.length}`;
    }
    await this.query(
      `UPDATE privacy_cleanup_jobs
          SET status = 'pending', attempt_count = attempt_count + 1,
              next_retry_at = $2, last_error = $3,
              lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE idempotency_key = $1
          AND status IN ('pending', 'processing')${leasePredicate}`,
      params,
    );
    if (current) {
      current.status = 'pending';
      current.attemptCount = attempts;
      current.nextRetryAt = nextRetryAt;
      current.lastError = error.slice(0, 160);
      current.leaseToken = undefined;
      current.leaseExpiresAt = undefined;
    }
  }

  async markStale(
    ref: Pick<PrivacyCleanupJobRef, 'idempotencyKey'>,
    leaseToken?: string,
  ): Promise<void> {
    const params: unknown[] = [ref.idempotencyKey];
    const leasePredicate = leaseToken ? ` AND lease_token = $2` : '';
    if (leaseToken) params.push(leaseToken);
    await this.query(
      `UPDATE privacy_cleanup_jobs
          SET status = 'stale', stale_at = now(), updated_at = now(),
              lease_token = NULL, lease_expires_at = NULL
        WHERE idempotency_key = $1
          AND status IN ('pending', 'processing')${leasePredicate}`,
      params,
    );
    const row = this.fallbackEnabled
      ? this.fallback.get(ref.idempotencyKey)
      : undefined;
    if (row) {
      row.status = 'stale';
      row.leaseToken = undefined;
      row.leaseExpiresAt = undefined;
    }
  }

  async claimDue(
    platform: Platform,
    limit = PRIVACY_CLEANUP_WORKER_BATCH_SIZE,
    leaseMs = PRIVACY_CLEANUP_WORKER_LEASE_MS,
  ): Promise<PrivacyCleanupJobRow[]> {
    // Make lease recovery observable as the documented pending state before
    // claiming again. The update is intentionally separate from the SKIP
    // LOCKED claim so the just-released rows are eligible in this tick.
    await this.query(
      `UPDATE privacy_cleanup_jobs
          SET status = 'pending', lease_token = NULL,
              lease_expires_at = NULL, next_retry_at = LEAST(next_retry_at, now()),
              updated_at = now()
        WHERE platform = $1
          AND status = 'processing'
          AND (lease_expires_at IS NULL OR lease_expires_at <= now())`,
      [platform],
    );
    const rows = extractQueryRows<Record<string, unknown>>(
      await this.query(
        `WITH due AS (
           SELECT id
             FROM privacy_cleanup_jobs
            WHERE platform = $1
              AND status = 'pending'
              AND next_retry_at <= now()
            ORDER BY next_retry_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         )
         UPDATE privacy_cleanup_jobs job
            SET status = 'processing',
                lease_token = md5(random()::text || job.id::text || clock_timestamp()::text),
                lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
                updated_at = now()
           FROM due
          WHERE job.id = due.id
         RETURNING job.id, job.cleanup_id, job.idempotency_key, job.operation,
                   job.platform, job.external_user_id, job.user_id,
                   job.mapping_generation, job.store, job.status,
                   job.attempt_count, job.next_retry_at, job.lease_token,
                   job.lease_expires_at, job.last_error`,
        [
          platform,
          Math.max(1, Math.min(limit, PRIVACY_CLEANUP_WORKER_BATCH_SIZE)),
          leaseMs,
        ],
      ),
    );
    if (rows.length > 0) return rows.map(toJobRow);
    if (!this.fallbackEnabled) return [];
    const now = Date.now();
    const fallback = [...this.fallback.values()]
      .filter(
        (row) =>
          row.platform === platform &&
          ((row.status === 'pending' &&
            (!row.nextRetryAt || row.nextRetryAt.getTime() <= now)) ||
            (row.status === 'processing' &&
              Boolean(
                row.leaseExpiresAt && row.leaseExpiresAt.getTime() <= now,
              ))),
      )
      .sort(
        (a, b) =>
          (a.nextRetryAt?.getTime() ?? 0) - (b.nextRetryAt?.getTime() ?? 0),
      )
      .slice(
        0,
        Math.max(1, Math.min(limit, PRIVACY_CLEANUP_WORKER_BATCH_SIZE)),
      );
    return fallback.map((row) => {
      row.status = 'processing';
      row.leaseToken = this.newLeaseToken();
      row.leaseExpiresAt = new Date(now + leaseMs);
      return { ...row };
    });
  }

  async getSummary(platform: Platform): Promise<PrivacyCleanupSummary> {
    const rows = (await this.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
         COUNT(*) FILTER (WHERE status = 'processing')::int AS processing_count,
         COUNT(*) FILTER (WHERE attempt_count > 0 AND status IN ('pending', 'processing'))::int AS retrying_count,
         EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status IN ('pending', 'processing'))))::int AS oldest_pending_age_seconds
       FROM privacy_cleanup_jobs
      WHERE platform = $1`,
      [platform],
    )) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (rows.length === 0 && this.fallbackEnabled) {
      const active = [...this.fallback.values()].filter(
        (entry) =>
          entry.platform === platform &&
          (entry.status === 'pending' || entry.status === 'processing'),
      );
      return {
        pendingCount: active.filter((entry) => entry.status === 'pending')
          .length,
        processingCount: active.filter((entry) => entry.status === 'processing')
          .length,
        retryingCount: active.filter((entry) => entry.attemptCount > 0).length,
        oldestPendingAgeSeconds: null,
      };
    }
    return {
      pendingCount: numberValue(row?.pending_count),
      processingCount: numberValue(row?.processing_count),
      retryingCount: numberValue(row?.retrying_count),
      oldestPendingAgeSeconds:
        row?.oldest_pending_age_seconds === null ||
        row?.oldest_pending_age_seconds === undefined
          ? null
          : numberValue(row.oldest_pending_age_seconds),
    };
  }

  async pruneRetention(): Promise<number> {
    const rows = extractQueryRows<{ id: string | number }>(
      await this.query(
        `DELETE FROM privacy_cleanup_jobs
         WHERE status IN ('completed', 'stale')
           AND COALESCE(completed_at, stale_at, updated_at) < now() - ($1::int * interval '1 day')
         RETURNING id`,
        [PRIVACY_CLEANUP_RETENTION_DAYS],
      ),
    );
    return rows.length;
  }

  newLeaseToken(): string {
    return randomUUID();
  }

  private async query<T>(
    sql: string,
    params: readonly unknown[],
  ): Promise<T[]> {
    if (typeof this.dataSource.query !== 'function') return [];
    return (await this.dataSource.query(sql, params)) as T[];
  }
}

function toJobRow(row: Record<string, unknown>): PrivacyCleanupJobRow {
  return {
    id: row.id === undefined ? undefined : String(row.id),
    cleanupId: String(row.cleanup_id),
    idempotencyKey: String(row.idempotency_key),
    operation: String(row.operation) as PrivacyCleanupOperation,
    platform: String(row.platform) as Platform,
    externalUserId: String(row.external_user_id),
    ...(row.user_id === null || row.user_id === undefined
      ? {}
      : { userId: Number(row.user_id) }),
    mappingGeneration: String(row.mapping_generation ?? '1'),
    store: String(row.store) as PrivacyCleanupStore,
    status: String(row.status) as PrivacyCleanupJobStatus,
    attemptCount: numberValue(row.attempt_count),
    ...(row.next_retry_at
      ? { nextRetryAt: new Date(String(row.next_retry_at)) }
      : {}),
    ...(row.lease_token ? { leaseToken: String(row.lease_token) } : {}),
    ...(row.lease_expires_at
      ? { leaseExpiresAt: new Date(String(row.lease_expires_at)) }
      : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
  };
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
