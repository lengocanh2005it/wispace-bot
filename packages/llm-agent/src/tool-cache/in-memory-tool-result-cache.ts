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

  get(key: string): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(undefined);
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return Promise.resolve(undefined);
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return Promise.resolve(entry.value);
  }

  set(key: string, value: unknown, ttlMs: number): Promise<void> {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldestKey: string | undefined = this.store.keys().next().value as
        | string
        | undefined;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return Promise.resolve();
  }

  invalidate(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  invalidatePrefix(prefix: string): Promise<void> {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
    return Promise.resolve();
  }
}
