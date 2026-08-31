import {
  WISPACE_CACHE_POLICY,
  type WispaceCacheKind,
} from './wispace-cache-policy';

interface CacheEntry {
  value: unknown;
  fetchedAt: number;
}

export interface WispaceDataCacheOptions {
  /** Max cached entries — expired entries are swept first, then oldest (default 10_000). */
  maxEntries?: number;
}

/**
 * Single cache layer for WISPACE reads (#636): TTL per data kind comes from
 * `WISPACE_CACHE_POLICY` — call sites cannot pick their own TTL. Bot-side
 * mutations call `invalidateUser` so the next read re-fetches (read-your-writes).
 * In-memory and per-process: on other pods staleness is bounded by the kind TTL.
 */
export class WispaceDataCache {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: WispaceDataCacheOptions = {}) {}

  async getOrFetch<T>(
    kind: WispaceCacheKind,
    externalUserId: string,
    args: Record<string, unknown> | undefined,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const key = this.buildKey(kind, externalUserId, args);
    const hit = this.cache.get(key);
    if (hit && now - hit.fetchedAt < WISPACE_CACHE_POLICY[kind]) {
      return hit.value as T;
    }

    const value = await fetcher();
    this.store(key, value, now);
    return value;
  }

  invalidateUser(externalUserId: string, kinds?: WispaceCacheKind[]): void {
    for (const key of [...this.cache.keys()]) {
      const parsed = parseKey(key);
      if (parsed?.userId !== externalUserId) {
        continue;
      }
      if (kinds && !kinds.includes(parsed.kind)) {
        continue;
      }
      this.cache.delete(key);
    }
  }

  private buildKey(
    kind: WispaceCacheKind,
    externalUserId: string,
    args: Record<string, unknown> | undefined,
  ): string {
    return JSON.stringify([kind, externalUserId, canonicalArgs(args)]);
  }

  private store(key: string, value: unknown, now: number): void {
    this.evictIfNeeded(now);
    this.cache.set(key, { value, fetchedAt: now });
  }

  private evictIfNeeded(now: number): void {
    if (this.cache.size < this.maxEntries) {
      return;
    }

    for (const [key, entry] of this.cache) {
      if (now - entry.fetchedAt >= entryTtl(key)) {
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

  private get maxEntries(): number {
    return this.options.maxEntries ?? 10_000;
  }
}

function parseKey(
  key: string,
): { kind: WispaceCacheKind; userId: string } | null {
  try {
    const [kind, userId] = JSON.parse(key) as [WispaceCacheKind, string];
    return { kind, userId };
  } catch {
    return null;
  }
}

function entryTtl(key: string): number {
  const parsed = parseKey(key);
  return parsed ? WISPACE_CACHE_POLICY[parsed.kind] : 0;
}

/** Deterministic arg serialization — sorted keys, undefined values skipped. */
function canonicalArgs(
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(args ?? {}).sort()) {
    const value = args?.[key];
    if (value !== undefined) {
      canonical[key] = value;
    }
  }
  return canonical;
}
