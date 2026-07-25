import type { ToolResultCachePort } from './tool-result-cache.port';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const DEFAULT_MAX_ENTRIES = 5000;

export class InMemoryToolResultCache implements ToolResultCachePort {
  private readonly store = new Map<string, CacheEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries?: number) {
    this.maxEntries = maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  get(key: string): unknown {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Move to end (LRU touch)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    // Evict oldest entries when at capacity
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldestKey: string | undefined = this.store.keys().next().value as
        | string
        | undefined;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.delete(key); // Remove before re-insert to update LRU order
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }
}
