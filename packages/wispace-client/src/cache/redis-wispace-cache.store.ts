import { randomUUID } from 'crypto';
import { maskExternalIdInText } from '@wispace/bot-common/masking';
import type { WispaceCacheSharedStore } from './wispace-cache-shared-store.port';

/**
 * Structural slice of the ioredis client — avoids a hard dependency and
 * keeps call sites honest about which commands the store uses.
 */
export interface WispaceCacheRedisCommands {
  get(key: string): Promise<string | null>;
  // Loose on purpose: ioredis overloads (set with PX/NX, eval, scan, del)
  // are structurally hard to mirror; the impl validates the shapes it uses.
  set(...args: unknown[]): Promise<unknown>;
  eval(...args: unknown[]): Promise<unknown>;
  scan(...args: unknown[]): Promise<unknown>;
  del(...keys: unknown[]): Promise<unknown>;
}

export interface RedisWispaceCacheStoreOptions {
  /** Warn hook for Redis failures — reads fail open, so errors must stay visible. */
  onWarn?: (message: string) => void;
  /** SCAN COUNT hint per page (default 100). */
  scanCount?: number;
}

const UNLOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

/**
 * Redis-backed `WispaceCacheSharedStore` (#568): every operation fails soft —
 * a Redis outage degrades to the local cache instead of breaking reads.
 * Locks are token-scoped (compare-and-delete) so an expired lease is never
 * stolen by another holder's unlock. Keys embed external user ids — warnings
 * mask them before surfacing.
 */
export class RedisWispaceCacheStore implements WispaceCacheSharedStore {
  private readonly warn: (message: string) => void;
  private readonly scanCount: number;

  constructor(
    private readonly client: WispaceCacheRedisCommands,
    options: RedisWispaceCacheStoreOptions = {},
  ) {
    this.warn = options.onWarn ?? (() => undefined);
    this.scanCount = options.scanCount ?? 100;
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (error) {
      this.warn(`redis cache get failed: ${safeMessage(error)}`);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, value, 'PX', ttlSeconds * 1000);
    } catch (error) {
      this.warn(`redis cache set failed: ${safeMessage(error)}`);
    }
  }

  async tryLock(key: string, ttlSeconds: number): Promise<string | null> {
    // One-time owner token: only this holder's unlock can release the key.
    const token = randomUUID();
    try {
      const result = await this.client.set(
        key,
        token,
        'PX',
        ttlSeconds * 1000,
        'NX',
      );
      return result === 'OK' ? token : null;
    } catch (error) {
      this.warn(`redis cache lock failed: ${safeMessage(error)}`);
      return null;
    }
  }

  async unlock(key: string, token: string): Promise<void> {
    try {
      await this.client.eval(UNLOCK_SCRIPT, 1, key, token);
    } catch (error) {
      this.warn(`redis cache unlock failed: ${safeMessage(error)}`);
    }
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    try {
      let cursor = '0';
      do {
        const result = (await this.client.scan(
          cursor,
          'MATCH',
          `${prefix}*`,
          'COUNT',
          this.scanCount,
        )) as unknown;
        const [next, keys] = result as [string, string[]];
        cursor = String(next ?? '0');
        if (Array.isArray(keys) && keys.length > 0) {
          await this.client.del(...keys);
        }
      } while (cursor !== '0');
    } catch (error) {
      this.warn(`redis cache deleteByPrefix failed: ${safeMessage(error)}`);
    }
  }
}

function safeMessage(error: unknown): string {
  // Error text can echo key names, which embed external user ids.
  return maskExternalIdInText(
    error instanceof Error ? error.message : String(error),
  );
}
