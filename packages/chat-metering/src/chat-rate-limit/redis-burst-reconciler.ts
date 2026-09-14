import { Logger } from '@nestjs/common';
import { maskExternalId } from '@wispace/bot-common/masking';
import type { RedisClientPort } from '@wispace/bot-common/redis';
import { runLockedTick } from '@wispace/bot-common/cron';
import type { LockedTickItem } from '@wispace/bot-common/cron';
import type { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import type Redis from 'ioredis';
import {
  buildLegacyRedisBurstKey,
  buildRedisBurstKey,
} from './redis-burst-counter';
import { CHAT_BURST_WINDOW_MS } from './memory-burst-counter';

export interface BurstReconciliationRepository {
  listBurstCountsForBucket(
    bucketStart: Date,
    bucketEnd: Date,
    options?: { includeRefunded?: boolean; limit?: number },
  ): Promise<{
    rows: Array<{ externalUserId: string; count: number }>;
    truncated: boolean;
  }>;
}

export interface RedisConsistencyMetrics {
  setRedisConsistencyDrift(datum: 'burst' | 'chat_queue', count: number): void;
  incRedisConsistencyEvent(
    datum: 'burst' | 'chat_queue',
    outcome:
      | 'detected'
      | 'repaired'
      | 'quarantined'
      | 'unresolved'
      | 'unavailable'
      | 'locked',
    count?: number,
  ): void;
}

export type RedisBurstReconciliationStatus =
  | 'clean'
  | 'drift'
  | 'partial'
  | 'unavailable'
  | 'locked';

export interface RedisBurstReconciliationResult {
  status: RedisBurstReconciliationStatus;
  scanned: number;
  mismatches: number;
  repaired: number;
  unresolved: number;
  truncated: boolean;
  sampleExternalIds: string[];
}

type RedisBurstItemDetail = 'clean' | 'repaired' | 'unresolved';

export interface RedisBurstReconcilerOptions {
  platform?: string;
  legacyRead?: boolean;
  includeRefunded?: boolean;
  maxCandidates?: number;
  metrics?: RedisConsistencyMetrics;
  pgLock?: PgAdvisoryLockService;
  lockId?: number;
  cronMetrics?: { recordCronSuccess(name: string): void };
  cronName?: string;
  now?: () => Date;
}

/**
 * Compares the current Redis advisory bucket with bounded PostgreSQL counts.
 * Missing Redis keys are cache eviction, not data loss; only a present,
 * divergent key is invalidated. Orphan-key scans are intentionally omitted:
 * they cannot prove a corresponding PG reservation and expire naturally.
 */
export class RedisBurstReconciler {
  private readonly logger = new Logger(RedisBurstReconciler.name);

  constructor(
    private readonly redisClient: Pick<
      RedisClientPort,
      'isEnabled' | 'getNativeClient'
    >,
    private readonly repository: BurstReconciliationRepository,
    private readonly options: RedisBurstReconcilerOptions = {},
  ) {}

  async reconcile(): Promise<RedisBurstReconciliationResult> {
    const empty = this.emptyResult.bind(this);
    const client = this.redisClient.getNativeClient();
    if (!this.redisClient.isEnabled() || !client) {
      this.record('unavailable');
      return empty('unavailable');
    }

    if (!this.options.pgLock || this.options.lockId === undefined) {
      this.record('unavailable');
      return empty('unavailable');
    }

    let batchResult:
      | {
          result: RedisBurstReconciliationResult;
          items: LockedTickItem<RedisBurstItemDetail>[];
        }
      | undefined;
    const summary = await runLockedTick<RedisBurstItemDetail>({
      name: this.options.cronName ?? `redis-burst-reconcile-${this.platform}`,
      withLock: (run) =>
        this.options.pgLock!.withLock(this.options.lockId!, run),
      run: async () => {
        batchResult = await this.reconcileBatch(client);
        return batchResult.items;
      },
      metrics: this.options.cronMetrics,
      logger: this.logger,
    });

    if (summary === null) return empty('locked');
    return batchResult?.result ?? empty('clean');
  }

  private emptyResult(
    status: RedisBurstReconciliationStatus,
    unresolved = 0,
  ): RedisBurstReconciliationResult {
    return {
      status,
      scanned: 0,
      mismatches: 0,
      repaired: 0,
      unresolved,
      truncated: false,
      sampleExternalIds: [],
    };
  }

  private async reconcileBatch(client: Redis): Promise<{
    result: RedisBurstReconciliationResult;
    items: LockedTickItem<RedisBurstItemDetail>[];
  }> {
    const now = this.options.now?.() ?? new Date();
    const bucketStart = new Date(
      Math.floor(now.getTime() / CHAT_BURST_WINDOW_MS) * CHAT_BURST_WINDOW_MS,
    );
    const bucketEnd = new Date(bucketStart.getTime() + CHAT_BURST_WINDOW_MS);
    const maxCandidates = Math.max(
      1,
      Math.floor(this.options.maxCandidates ?? 100),
    );
    const listed = await this.repository.listBurstCountsForBucket(
      bucketStart,
      bucketEnd,
      {
        includeRefunded: this.options.includeRefunded ?? false,
        limit: maxCandidates,
      },
    );

    let mismatches = 0;
    let repaired = 0;
    let unresolved = 0;
    const sampleExternalIds: string[] = [];
    const items: LockedTickItem<RedisBurstItemDetail>[] = [];
    for (const row of listed.rows) {
      try {
        const bucket = Math.floor(bucketStart.getTime() / CHAT_BURST_WINDOW_MS);
        const key = buildRedisBurstKey(
          this.platform,
          row.externalUserId,
          bucket,
        );
        const raw =
          (await client.get(key)) ??
          (this.legacyRead
            ? await client.get(
                buildLegacyRedisBurstKey(row.externalUserId, bucket),
              )
            : null);
        if (raw == null) {
          items.push({ outcome: 'succeeded', details: 'clean' });
          continue;
        }
        const redisCount = Number(raw);
        if (Number.isFinite(redisCount) && redisCount === row.count) {
          items.push({ outcome: 'succeeded', details: 'clean' });
          continue;
        }

        mismatches += 1;
        if (sampleExternalIds.length < 5) {
          sampleExternalIds.push(maskExternalId(row.externalUserId));
        }
        this.record('detected', 1);
        try {
          const keys = [key];
          if (this.legacyRead)
            keys.push(buildLegacyRedisBurstKey(row.externalUserId, bucket));
          await client.del(...keys);
          repaired += 1;
          this.record('repaired', 1);
          items.push({ outcome: 'succeeded', details: 'repaired' });
        } catch {
          unresolved += 1;
          this.record('unresolved', 1);
          items.push({ outcome: 'failed', details: 'unresolved' });
        }
      } catch {
        unresolved += 1;
        this.record('unavailable', 1);
        items.push({ outcome: 'failed', details: 'unresolved' });
      }
    }

    this.options.metrics?.setRedisConsistencyDrift('burst', unresolved);
    return {
      result: {
        status:
          unresolved > 0 ? 'drift' : listed.truncated ? 'partial' : 'clean',
        scanned: listed.rows.length,
        mismatches,
        repaired,
        unresolved,
        truncated: listed.truncated,
        sampleExternalIds,
      },
      items,
    };
  }

  private get platform(): string {
    return this.options.platform ?? 'messenger';
  }

  private get legacyRead(): boolean {
    return this.options.legacyRead ?? this.platform === 'messenger';
  }

  private record(
    outcome: 'detected' | 'repaired' | 'unresolved' | 'unavailable' | 'locked',
    count = 1,
  ): void {
    this.options.metrics?.incRedisConsistencyEvent('burst', outcome, count);
  }
}
