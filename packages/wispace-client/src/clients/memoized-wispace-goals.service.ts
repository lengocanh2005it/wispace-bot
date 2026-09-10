import type { UserGoalsRecord } from '../types/user-goals.types';
import type { TaskScoreAverageRecord } from '../types/task-score-average.types';
import type { WispaceDataCache } from '../cache/wispace-data-cache';

/** Core delegate contract; NestJS service wrappers satisfy it structurally. */
export interface WispaceGoalsPort {
  getUserGoals(
    externalUserId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UserGoalsRecord>;
  getTaskScoreAverages(
    externalUserId: string,
    options?: { signal?: AbortSignal },
  ): Promise<TaskScoreAverageRecord[]>;
}

/**
 * Goals-shaped facade over the shared `WispaceDataCache` (#636). The report
 * pipeline fetches goals multiple times within one execution (exam window →
 * orchestration exam-date parse → report generation); the cache collapses
 * them into one upstream call without changing any caller. TTL comes from
 * the central policy — per-instance overrides were removed so a call site
 * cannot opt out of the staleness bound.
 * Plain class — instantiate per app module via `useFactory`.
 */
export class MemoizedWispaceGoalsService {
  constructor(
    private readonly delegate: WispaceGoalsPort,
    private readonly cache: WispaceDataCache,
  ) {}

  getUserGoals(
    externalUserId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UserGoalsRecord> {
    return this.cache.getOrFetch('goals', externalUserId, undefined, () =>
      this.delegate.getUserGoals(externalUserId, options),
    );
  }

  getTaskScoreAverages(
    externalUserId: string,
    options?: { signal?: AbortSignal },
  ): Promise<TaskScoreAverageRecord[]> {
    return this.delegate.getTaskScoreAverages(externalUserId, options);
  }
}
