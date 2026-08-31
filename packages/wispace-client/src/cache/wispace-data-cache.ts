import {
  WISPACE_CACHE_POLICY,
  type WispaceCacheKind,
} from './wispace-cache-policy';
import type { WispaceCacheSharedStore } from './wispace-cache-shared-store.port';

interface CacheEntry {
  value: unknown;
  fetchedAt: number;
}

interface SharedEnvelope {
  kind: WispaceCacheKind;
  userId: string;
  fetchedAt: number;
  value: unknown;
}

export interface WispaceDataCacheOptions {
  /** Max local entries — expired entries are swept first, then oldest (default 10_000). */
  maxEntries?: number;
  /**
   * Optional cross-pod coordination store (#568). When present, a local miss
   * first checks the shared store, coordinates a single upstream fetch across
   * pods via a lock, and writes through. Best-effort — store failures fail
   * open to a local fetch.
   */
  sharedStore?: WispaceCacheSharedStore;
  /** Poll interval while waiting for another pod's fetch (default 50ms). */
  coordinationPollMs?: number;
  /** Max time a waiter waits for the lock holder before fetching locally (default 2000ms). */
  coordinationWaitBudgetMs?: number;
}

const DEFAULT_COORDINATION_POLL_MS = 50;
const DEFAULT_COORDINATION_WAIT_BUDGET_MS = 2_000;
/** Lock lease — a crashed holder frees the key after this (Redis PX). */
const LOCK_TTL_SECONDS = 5;
/** ±10% shared-TTL jitter spreads expiry so pods do not stampede together. */
const TTL_JITTER_RATIO = 0.1;

const KEY_NS = 'wispace-cache:';
const KEY_SEP = '\u001f';

/**
 * Single cache layer for WISPACE reads (#636): TTL per data kind comes from
 * `WISPACE_CACHE_POLICY` — call sites cannot pick their own TTL. Bot-side
 * mutations call `invalidateUser` so the next read re-fetches
 * (read-your-writes). In-memory per process; with a `sharedStore` wired,
 * concurrent callers share one in-flight fetch (per-key dedup) and pods
 * coordinate through the store so a miss produces one upstream call (#568).
 * All coordination is best-effort: store failures fail open to a local
 * fetch; corrupt or stale shared values are misses.
 */
export class WispaceDataCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly sharedStore?: WispaceCacheSharedStore;
  private readonly pollMs: number;
  private readonly waitBudgetMs: number;
  private readonly maxEntries: number;

  constructor(options: WispaceDataCacheOptions = {}) {
    this.sharedStore = options.sharedStore;
    this.pollMs = options.coordinationPollMs ?? DEFAULT_COORDINATION_POLL_MS;
    this.waitBudgetMs =
      options.coordinationWaitBudgetMs ?? DEFAULT_COORDINATION_WAIT_BUDGET_MS;
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  async getOrFetch<T>(
    kind: WispaceCacheKind,
    externalUserId: string,
    args: Record<string, unknown> | undefined,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const key = buildKey(kind, externalUserId, args);
    const hit = this.cache.get(key);
    if (hit && now - hit.fetchedAt < WISPACE_CACHE_POLICY[kind]) {
      return hit.value as T;
    }

    // Per-key in-flight dedup (#568): concurrent misses share one fetch —
    // waiters share the fetcher's outcome, including its failure and its
    // abort signal (the LLM deadline covers the whole conversation turn, so
    // an aborted holder aborts the shared call for every waiter — desired).
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending as Promise<T>;
    }

    const promise = this.fetchAndStore<T>(kind, key, fetcher).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
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

    void this.invalidateShared(externalUserId, kinds);
  }

  private async invalidateShared(
    externalUserId: string,
    kinds?: WispaceCacheKind[],
  ): Promise<void> {
    const store = this.sharedStore;
    if (!store) {
      return;
    }
    try {
      const prefixes = kinds
        ? kinds.map(
            (kind) => `${KEY_NS}${externalUserId}${KEY_SEP}${kind}${KEY_SEP}`,
          )
        : [`${KEY_NS}${externalUserId}${KEY_SEP}`];
      for (const prefix of prefixes) {
        await store.deleteByPrefix(prefix);
      }
    } catch {
      // Invalidation is best-effort — the TTL bound still applies.
    }
  }

  private async fetchAndStore<T>(
    kind: WispaceCacheKind,
    key: string,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    if (this.sharedStore) {
      const shared = await this.coordinateViaSharedStore<T>(kind, key, fetcher);
      if (shared !== null) {
        this.store(key, shared.value, shared.fetchedAt);
        return shared.value as T;
      }
    }

    const now = Date.now();
    const value = await fetcher();
    this.store(key, value, now);
    void this.writeThrough(kind, key, value, now);
    return value;
  }

  /**
   * Shared-store path: read-through, then coordinate the fetch across pods —
   * lock, re-check (the first caller's write must be observable, #568),
   * fetch, write-through, unlock. Returns null when the caller must fetch
   * locally: no value and lock not acquired within the wait budget, or any
   * store failure. A fetcher failure is NOT swallowed — it propagates (a
   * failed fetch must not trigger a second upstream call for the same miss),
   * and the lock is released in `finally`.
   */
  private async coordinateViaSharedStore<T>(
    kind: WispaceCacheKind,
    key: string,
    fetcher: () => Promise<T>,
  ): Promise<SharedEnvelope | null> {
    const store = this.sharedStore;
    if (!store) {
      return null;
    }

    let token: string | null = null;
    try {
      const existing = await this.readShared(kind, key);
      if (existing !== null) {
        return existing;
      }

      token = await store.tryLock(lockKey(key), LOCK_TTL_SECONDS);
      if (token === null) {
        return await this.waitForHolder(kind, key);
      }
    } catch {
      // Coordination is best-effort — fall back to a local fetch.
      return null;
    }

    // Lock acquired — fetcher failures propagate (never re-fetch here).
    try {
      // Second check after acquiring the lock (#568): the first caller may
      // have written the value between our read and the lock grant.
      const recheck = await this.readSharedOrNull(kind, key);
      if (recheck !== null) {
        return recheck;
      }

      const now = Date.now();
      const value = await fetcher();
      const envelope: SharedEnvelope = {
        kind,
        userId: parseKey(key)?.userId ?? '',
        fetchedAt: now,
        value,
      };
      await store.set(
        key,
        encodeEnvelope(envelope),
        ttlSecondsWithJitter(kind),
      );
      return envelope;
    } finally {
      await store.unlock(lockKey(key), token).catch(() => undefined);
    }
  }

  private async readShared(
    kind: WispaceCacheKind,
    key: string,
  ): Promise<SharedEnvelope | null> {
    const store = this.sharedStore;
    if (!store) {
      return null;
    }
    const raw = await store.get(key);
    if (!raw) {
      return null;
    }
    const envelope = decodeEnvelope(raw);
    if (
      !envelope ||
      envelope.kind !== kind ||
      envelope.userId !== parseKey(key)?.userId
    ) {
      return null;
    }
    if (Date.now() - envelope.fetchedAt >= WISPACE_CACHE_POLICY[kind]) {
      return null;
    }
    return envelope;
  }

  /** Store failures during the lock-held second check are just a miss. */
  private async readSharedOrNull(
    kind: WispaceCacheKind,
    key: string,
  ): Promise<SharedEnvelope | null> {
    try {
      return await this.readShared(kind, key);
    } catch {
      return null;
    }
  }

  /**
   * Bounded wait for the lock holder's write: poll the shared value until it
   * appears or the budget/iteration cap runs out (the cap keeps the loop
   * finite even under a frozen clock), then fail open to a local fetch.
   */
  private async waitForHolder(
    kind: WispaceCacheKind,
    key: string,
  ): Promise<SharedEnvelope | null> {
    const deadline = Date.now() + this.waitBudgetMs;
    const maxPolls = Math.ceil(this.waitBudgetMs / this.pollMs) + 1;
    for (let poll = 0; poll < maxPolls && Date.now() < deadline; poll++) {
      await sleep(this.pollMs);
      const shared = await this.readSharedOrNull(kind, key);
      if (shared !== null) {
        return shared;
      }
    }
    return null;
  }

  /** Best-effort write-through — never blocks or fails the caller. */
  private async writeThrough(
    kind: WispaceCacheKind,
    key: string,
    value: unknown,
    fetchedAt: number,
  ): Promise<void> {
    if (!this.sharedStore) {
      return;
    }
    const envelope: SharedEnvelope = {
      kind,
      userId: parseKey(key)?.userId ?? '',
      fetchedAt,
      value,
    };
    try {
      await this.sharedStore.set(
        key,
        encodeEnvelope(envelope),
        ttlSecondsWithJitter(kind),
      );
    } catch {
      // The local cache already serves this caller.
    }
  }

  private store(key: string, value: unknown, fetchedAt: number): void {
    this.evictIfNeeded(fetchedAt);
    this.cache.set(key, { value, fetchedAt });
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
}

function buildKey(
  kind: WispaceCacheKind,
  externalUserId: string,
  args: Record<string, unknown> | undefined,
): string {
  // User first so `invalidateUser` can prefix-delete shared keys; KEY_SEP is
  // a control character that platform ids and kinds never contain.
  return `${KEY_NS}${externalUserId}${KEY_SEP}${kind}${KEY_SEP}${JSON.stringify(
    canonicalArgs(args),
  )}`;
}

function parseKey(
  key: string,
): { kind: WispaceCacheKind; userId: string } | null {
  if (!key.startsWith(KEY_NS)) {
    return null;
  }
  const parts = key.slice(KEY_NS.length).split(KEY_SEP);
  if (parts.length < 3) {
    return null;
  }
  return { userId: parts[0], kind: parts[1] as WispaceCacheKind };
}

function lockKey(key: string): string {
  return `${KEY_NS}lock${KEY_SEP}${key}`;
}

function ttlSecondsWithJitter(kind: WispaceCacheKind): number {
  const base = WISPACE_CACHE_POLICY[kind] / 1000;
  const jitter = base * TTL_JITTER_RATIO;
  return Math.max(1, Math.round(base + (Math.random() * 2 - 1) * jitter));
}

/** Date-safe envelope codec — calendar sessions carry `Date` objects. */
function encodeEnvelope(envelope: SharedEnvelope): string {
  // JSON.stringify consults Date.toJSON() BEFORE any replacer, so Dates must
  // be replaced by a manual walk — a replacer never sees a Date instance.
  return JSON.stringify({ ...envelope, value: encodeDates(envelope.value) });
}

function encodeDates(value: unknown): unknown {
  if (value instanceof Date) {
    return { $date: value.getTime() };
  }
  if (Array.isArray(value)) {
    return value.map(encodeDates);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = encodeDates(entry);
    }
    return out;
  }
  return value;
}

function decodeEnvelope(raw: string): SharedEnvelope | null {
  try {
    const envelope = JSON.parse(raw, (_key, value) => {
      if (
        value &&
        typeof value === 'object' &&
        '$date' in value &&
        Object.keys(value).length === 1
      ) {
        return new Date((value as { $date: number }).$date);
      }
      return value;
    }) as SharedEnvelope;
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      typeof envelope.kind !== 'string' ||
      typeof envelope.userId !== 'string' ||
      typeof envelope.fetchedAt !== 'number' ||
      !Object.hasOwn(WISPACE_CACHE_POLICY, envelope.kind)
    ) {
      return null;
    }
    return envelope;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
