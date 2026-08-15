import type { UserGoalsRecord } from '../types/user-goals.types';
import type { TaskScoreAverageRecord } from '../types/task-score-average.types';
import type { WispaceGoalsService } from './wispace-goals.service';

export interface MemoizedGoalsServiceOptions {
  /** How long a cached goals record stays valid (default 60s). */
  ttlMs?: number;
  /** Max cached users — oldest entries are evicted first (default 10_000). */
  maxEntries?: number;
}

interface CacheEntry {
  value: UserGoalsRecord;
  fetchedAt: number;
}

/**
 * Short-TTL memoizer over `WispaceGoalsService.getUserGoals`. The report
 * pipeline fetches goals multiple times within one execution (exam window →
 * orchestration exam-date parse → report generation); a request-scoped
 * memoizer collapses them into one upstream call without changing any caller.
 * Plain class — instantiate per app module via `useFactory`.
 */
export class MemoizedWispaceGoalsService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly delegate: WispaceGoalsService,
    private readonly options: MemoizedGoalsServiceOptions = {},
  ) {}

  getUserGoals(
    externalUserId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UserGoalsRecord> {
    const now = Date.now();
    const hit = this.cache.get(externalUserId);
    if (hit && now - hit.fetchedAt < this.ttlMs) {
      return Promise.resolve(hit.value);
    }

    return this.delegate.getUserGoals(externalUserId, options).then((value) => {
      this.store(externalUserId, value, now);
      return value;
    });
  }

  getTaskScoreAverages(
    externalUserId: string,
    options?: { signal?: AbortSignal },
  ): Promise<TaskScoreAverageRecord[]> {
    return this.delegate.getTaskScoreAverages(externalUserId, options);
  }

  private store(
    externalUserId: string,
    value: UserGoalsRecord,
    now: number,
  ): void {
    this.evictIfNeeded(now);
    this.cache.set(externalUserId, { value, fetchedAt: now });
  }

  private evictIfNeeded(now: number): void {
    if (this.cache.size < this.maxEntries) {
      return;
    }

    for (const [key, entry] of this.cache) {
      if (now - entry.fetchedAt >= this.ttlMs) {
        this.cache.delete(key);
        break;
      }
    }

    if (this.cache.size >= this.maxEntries) {
      // Map preserves insertion order — the first key is the oldest.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }

  private get ttlMs(): number {
    return this.options.ttlMs ?? 60_000;
  }

  private get maxEntries(): number {
    return this.options.maxEntries ?? 10_000;
  }
}
