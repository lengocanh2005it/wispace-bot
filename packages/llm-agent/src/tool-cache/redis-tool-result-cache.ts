import type { ToolResultCachePort } from './tool-result-cache.port';

/**
 * Minimal Redis client interface — implemented by ioredis or any compatible client.
 * Only the methods needed by the cache are declared to avoid hard dependency.
 */
export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, ttlMs?: number): Promise<'OK'>;
  del(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
}

const KEY_PREFIX = 'llm-agent:tool-cache:';

/**
 * Redis-backed tool result cache for multi-pod deployments.
 * Values are JSON-serialized with a TTL managed by Redis EXPIRE.
 */
export class RedisToolResultCache implements ToolResultCachePort {
  constructor(private readonly redis: RedisCacheClient) {}

  async get(key: string): Promise<unknown> {
    const raw = await this.redis.get(`${KEY_PREFIX}${key}`);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    const serialized = JSON.stringify(value);
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    await this.redis.set(`${KEY_PREFIX}${key}`, serialized, 'EX', ttlSec);
  }

  async invalidate(key: string): Promise<void> {
    await this.redis.del(`${KEY_PREFIX}${key}`);
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    const pattern = `${KEY_PREFIX}${prefix}*`;
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await Promise.all(keys.map((k) => this.redis.del(k)));
    }
  }
}
