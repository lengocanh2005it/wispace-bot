export interface ToolResultCachePort {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
  invalidate(key: string): Promise<void>;
  invalidatePrefix(prefix: string): Promise<void>;
}

export const NOOP_TOOL_RESULT_CACHE: ToolResultCachePort = {
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
  invalidate: () => Promise.resolve(),
  invalidatePrefix: () => Promise.resolve(),
};
