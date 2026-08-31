/**
 * Cross-pod coordination surface for `WispaceDataCache` (#568 stampede
 * protection): a Redis-backed implementation lives in the consuming app and
 * is wired optionally. All methods are best-effort — implementers must
 * fail soft (the cache treats any rejection or `false` as "no coordination").
 *
 * Keying contract: `key` is the cache's own namespaced key; implementations
 * may prefix it with a platform namespace. Locks are token-scoped — `tryLock`
 * returns the owner token, `unlock` must only release when the token still
 * matches (compare-and-delete), so a lease-expired lock is never stolen.
 */
export interface WispaceCacheSharedStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Atomic SET-NX-style claim; null when another caller holds the lock. */
  tryLock(key: string, ttlSeconds: number): Promise<string | null>;
  /** Compare-and-delete — must release only while `token` still owns the lock. */
  unlock(key: string, token: string): Promise<void>;
  deleteByPrefix(prefix: string): Promise<void>;
}
