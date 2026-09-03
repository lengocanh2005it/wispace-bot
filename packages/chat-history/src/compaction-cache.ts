import { createHash } from 'node:crypto';
import type { ChatHistoryMessage } from './types';
import type { RedisChatHistoryClient } from './redis-chat-history-store';

/**
 * Coverage marker identifying exactly which history prefix a cached summary
 * covers (#704). A cached summary is reusable only when both fields match
 * the current dropped prefix — append-only history means an unchanged
 * prefix always reproduces the same marker.
 */
export interface CompactionCoverage {
  /** Number of dropped entries the summary covers. */
  count: number;
  /** sha256 over every covered entry's content, hex, truncated to 16 chars. */
  hash: string;
}

export interface CompactionSummary {
  /** Fact-stripped summary text (stripped BEFORE persist, never after read). */
  text: string;
  coverage: CompactionCoverage;
}

/**
 * Persisted compaction-summary cache (#704). Implementations are already
 * platform-scoped (one instance per platform history service), so keys only
 * carry the external user id. All failures must be fail-open at the call
 * site — the cache never blocks a reply.
 */
export interface CompactionCachePort {
  get(externalUserId: string): Promise<CompactionSummary | null>;
  set(externalUserId: string, summary: CompactionSummary): Promise<void>;
  clear(externalUserId: string): Promise<void>;
}

/**
 * Marker for a dropped history prefix. Null when there is nothing to cover.
 * The hash runs over EVERY covered entry — first+last alone cannot tell
 * `[A,B,C]` apart from `[A,X,C]`, and a stale summary for a different middle
 * is a correctness bug, not just wasted tokens. Hashing a few KB is
 * microseconds next to the LLM call this cache saves.
 */
export function computeCompactionCoverage(
  entries: Array<Pick<ChatHistoryMessage, 'content'>>,
): CompactionCoverage | null {
  if (entries.length === 0) return null;
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.content, 'utf8');
    hash.update('\n', 'utf8');
  }
  return { count: entries.length, hash: hash.digest('hex').slice(0, 16) };
}

function isCompactionSummary(value: unknown): value is CompactionSummary {
  if (typeof value !== 'object' || value === null) return false;
  const summary = value as Record<string, unknown>;
  if (typeof summary.text !== 'string') return false;
  const coverage = summary.coverage as Record<string, unknown> | undefined;
  return (
    typeof coverage?.count === 'number' && typeof coverage?.hash === 'string'
  );
}

export interface MemoryCompactionCacheConfig {
  /** Idle-eviction window, mirrors the history TTL. */
  ttlMs: number;
  /** Global user cap — oldest-updated users evicted beyond this. */
  maxUsers?: number;
  /** Sweep interval for expiry/cap enforcement. */
  sweepMs?: number;
}

interface MemoryCompactionState {
  summary: CompactionSummary;
  updatedAt: number;
}

/**
 * Per-process compaction cache (memory history mode). Same lifecycle rules
 * as `MemoryChatHistoryStore`: lazy expiry on read, sweep timer for the
 * rest. Call `dispose()` on shutdown.
 */
export class MemoryCompactionCache implements CompactionCachePort {
  /** Visible to tests for storage-level corruption probes. */
  readonly store = new Map<string, MemoryCompactionState>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly config: MemoryCompactionCacheConfig) {
    this.timer = setInterval(() => this.evictStale(), this.sweepMs);
    this.timer.unref?.();
  }

  get(externalUserId: string): Promise<CompactionSummary | null> {
    const state = this.store.get(externalUserId);
    if (!state || Date.now() - state.updatedAt > this.config.ttlMs) {
      if (state) this.store.delete(externalUserId);
      return Promise.resolve(null);
    }
    return Promise.resolve(
      isCompactionSummary(state.summary) ? state.summary : null,
    );
  }

  set(externalUserId: string, summary: CompactionSummary): Promise<void> {
    this.store.set(externalUserId, { summary, updatedAt: Date.now() });
    return Promise.resolve();
  }

  clear(externalUserId: string): Promise<void> {
    this.store.delete(externalUserId);
    return Promise.resolve();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.store.clear();
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [externalUserId, state] of this.store) {
      if (now - state.updatedAt > this.config.ttlMs) {
        this.store.delete(externalUserId);
      }
    }
    if (this.store.size > this.maxUsers) {
      const byAge = [...this.store.entries()].sort(
        ([, left], [, right]) => left.updatedAt - right.updatedAt,
      );
      for (const [externalUserId] of byAge) {
        if (this.store.size <= this.maxUsers) break;
        this.store.delete(externalUserId);
      }
    }
  }

  private get maxUsers(): number {
    return this.config.maxUsers ?? 10_000;
  }

  private get sweepMs(): number {
    return this.config.sweepMs ?? 60_000;
  }
}

export interface RedisCompactionCacheConfig {
  /** TTL in seconds, mirrors the history ttlSec (sliding, refreshed on hit). */
  ttlSec: number;
  /** History key prefix, e.g. 'chat-history:discord:'. */
  keyPrefix: string;
}

/**
 * Shared compaction cache (Redis history mode) — one summary per user,
 * visible across pods. Last-writer-wins on concurrent sets; in-process
 * duplicate summarizations are deduped upstream by singleflight in
 * `LlmAgentService` (only the generator can share its in-flight call).
 */
export class RedisCompactionCache implements CompactionCachePort {
  /** Visible to tests for client-level probes. */
  readonly client: RedisChatHistoryClient;

  constructor(
    client: RedisChatHistoryClient,
    private readonly config: RedisCompactionCacheConfig,
  ) {
    this.client = client;
  }

  async get(externalUserId: string): Promise<CompactionSummary | null> {
    const raw = await this.client.get(this.key(externalUserId));
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    if (!isCompactionSummary(parsed)) return null;
    // Sliding expiry — a reused summary is still live, like history itself.
    await this.client.set(
      this.key(externalUserId),
      raw,
      'EX',
      this.config.ttlSec,
    );
    return parsed;
  }

  async set(externalUserId: string, summary: CompactionSummary): Promise<void> {
    await this.client.set(
      this.key(externalUserId),
      JSON.stringify(summary),
      'EX',
      this.config.ttlSec,
    );
  }

  async clear(externalUserId: string): Promise<void> {
    await this.client.del(this.key(externalUserId));
  }

  private key(externalUserId: string): string {
    return `${this.config.keyPrefix}compaction:${externalUserId}`;
  }
}
