export interface ToolResultCachePort {
  get(key: string): unknown;
  set(key: string, value: unknown, ttlMs: number): void;
  invalidate(key: string): void;
  /** Removes all keys whose string starts with the given prefix. */
  invalidatePrefix(prefix: string): void;
}

/**
 * Async variant of ToolResultCachePort for backends like Redis.
 * The agent loop always awaits cache calls, so either interface works.
 */
export interface AsyncToolResultCachePort {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
  invalidate(key: string): Promise<void>;
  invalidatePrefix(prefix: string): Promise<void>;
}

export const NOOP_TOOL_RESULT_CACHE: ToolResultCachePort = {
  get: () => undefined,
  set: () => undefined,
  invalidate: () => undefined,
  invalidatePrefix: () => undefined,
};

/** Wraps a sync cache behind the async interface. */
export function toAsyncCache(
  cache: ToolResultCachePort,
): AsyncToolResultCachePort {
  return {
    get: (key) => Promise.resolve(cache.get(key)),
    set: (key, value, ttlMs) => {
      cache.set(key, value, ttlMs);
      return Promise.resolve();
    },
    invalidate: (key) => {
      cache.invalidate(key);
      return Promise.resolve();
    },
    invalidatePrefix: (prefix) => {
      cache.invalidatePrefix(prefix);
      return Promise.resolve();
    },
  };
}
