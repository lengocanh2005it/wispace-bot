import { maskExternalId } from '@wispace/bot-common/masking';
import type { RedisClientPort } from '@wispace/bot-common/redis';
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

export interface RedisBurstReconcilerOptions {
  platform?: string;
  legacyRead?: boolean;
  includeRefunded?: boolean;
  maxCandidates?: number;
  metrics?: RedisConsistencyMetrics;
  now?: () => Date;
}

/**
 * Compares the current Redis advisory bucket with bounded PostgreSQL counts.
 * Missing Redis keys are cache eviction, not data loss; only a present,
 * divergent key is invalidated. Orphan-key scans are intentionally omitted:
 * they cannot prove a corresponding PG reservation and expire naturally.
 */
export class RedisBurstReconciler {
  private static readonly LOCK_TTL_MS = 55_000;

  constructor(
    private readonly redisClient: Pick<
      RedisClientPort,
      'isEnabled' | 'getNativeClient'
    >,
    private readonly repository: BurstReconciliationRepository,
    private readonly options: RedisBurstReconcilerOptions = {},
  ) {}

  async reconcile(): Promise<RedisBurstReconciliationResult> {
    const empty = (status: RedisBurstReconciliationStatus, unresolved = 0) => ({
      status,
      scanned: 0,
      mismatches: 0,
      repaired: 0,
      unresolved,
      truncated: false,
      sampleExternalIds: [],
    });
    const client = this.redisClient.getNativeClient();
    if (!this.redisClient.isEnabled() || !client) {
      this.record('unavailable');
      return empty('unavailable');
    }

    const lockKey = `chat:quota:${this.platform}:reconcile-lock`;
    const lockValue = `${Date.now()}:${Math.random()}`;
    let acquired: string | null;
    try {
      acquired = await client.set(
        lockKey,
        lockValue,
        'PX',
        RedisBurstReconciler.LOCK_TTL_MS,
        'NX',
      );
    } catch {
      this.record('unavailable');
      this.options.metrics?.setRedisConsistencyDrift('burst', 0);
      return empty('unavailable');
    }
    if (acquired !== 'OK') {
      this.record('locked');
      return empty('locked');
    }

    try {
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
      for (const row of listed.rows) {
        const key = buildRedisBurstKey(
          this.platform,
          row.externalUserId,
          Math.floor(bucketStart.getTime() / CHAT_BURST_WINDOW_MS),
        );
        const raw =
          (await client.get(key)) ??
          (this.legacyRead
            ? await client.get(
                buildLegacyRedisBurstKey(
                  row.externalUserId,
                  Math.floor(bucketStart.getTime() / CHAT_BURST_WINDOW_MS),
                ),
              )
            : null);
        if (raw == null) continue;
        const redisCount = Number(raw);
        if (Number.isFinite(redisCount) && redisCount === row.count) continue;

        mismatches += 1;
        if (sampleExternalIds.length < 5) {
          sampleExternalIds.push(maskExternalId(row.externalUserId));
        }
        this.record('detected', 1);
        try {
          const keys = [key];
          if (this.legacyRead) {
            keys.push(
              buildLegacyRedisBurstKey(
                row.externalUserId,
                Math.floor(bucketStart.getTime() / CHAT_BURST_WINDOW_MS),
              ),
            );
          }
          await client.del(...keys);
          repaired += 1;
          this.record('repaired', 1);
        } catch {
          unresolved += 1;
          this.record('unresolved', 1);
        }
      }

      this.options.metrics?.setRedisConsistencyDrift('burst', unresolved);
      return {
        status:
          unresolved > 0 ? 'drift' : listed.truncated ? 'partial' : 'clean',
        scanned: listed.rows.length,
        mismatches,
        repaired,
        unresolved,
        truncated: listed.truncated,
        sampleExternalIds,
      };
    } catch {
      this.options.metrics?.setRedisConsistencyDrift('burst', 1);
      this.record('unresolved');
      return empty('drift', 1);
    } finally {
      await this.releaseLock(client, lockKey, lockValue);
    }
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

  private async releaseLock(
    client: Redis,
    lockKey: string,
    lockValue: string,
  ): Promise<void> {
    try {
      await client.eval(
        `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`,
        1,
        lockKey,
        lockValue,
      );
    } catch {
      // Lease expiry is the safety net if Redis disappears during cleanup.
    }
  }
}
