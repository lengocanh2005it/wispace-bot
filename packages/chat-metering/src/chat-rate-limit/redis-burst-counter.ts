import type { RedisClientPort } from '@wispace/bot-common';
import { CHAT_BURST_WINDOW_MS } from './memory-burst-counter';
import type { BurstCounterPort } from './types';

export const CHAT_BURST_KEY_TTL_SECONDS = 120;

/**
 * Redis-backed burst counter with automatic TTL expiry and Postgres fallback.
 *
 * Uses an atomic Lua script for INCR + EXPIRE + DECR-if-over-limit to avoid
 * the race where two concurrent requests both pass the read check.
 *
 * When Redis is unavailable, returns { allowed: true, transactional: true }
 * so the Postgres reserve transaction enforces the burst limit as a fallback.
 */
export class RedisBurstCounter implements BurstCounterPort {
  private static readonly KEY_PREFIX = 'burst:';

  constructor(private readonly redisClient: RedisClientPort) {}

  isAvailable(): boolean {
    return (
      this.redisClient.isEnabled() &&
      this.redisClient.getNativeClient() !== null
    );
  }

  async getBurstCount(externalUserId: string): Promise<number> {
    const client = this.redisClient.getNativeClient();
    if (!client) {
      return 0;
    }

    try {
      const raw = await client.get(this.key(externalUserId));
      return Number(raw ?? 0);
    } catch {
      // ponytail: log-and-fallback, not throw — burst is best-effort
      return 0;
    }
  }

  async tryReserveBurst(
    externalUserId: string,
    limit: number,
  ): Promise<{ allowed: boolean; count: number; transactional: boolean }> {
    const client = this.redisClient.getNativeClient();
    if (!client) {
      return { allowed: true, count: 0, transactional: true };
    }

    const key = this.key(externalUserId);
    const luaScript = `
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then
        redis.call('EXPIRE', KEYS[1], ARGV[1])
      end
      if count > tonumber(ARGV[2]) then
        redis.call('DECR', KEYS[1])
        return {0, count - 1}
      end
      return {1, count}
    `;

    try {
      const result = (await client.eval(
        luaScript,
        1,
        key,
        String(CHAT_BURST_KEY_TTL_SECONDS),
        String(limit),
      )) as number[];
      return {
        allowed: result[0] === 1,
        count: result[1] ?? 0,
        transactional: false,
      };
    } catch {
      // Redis unavailable — let Postgres reserve transaction enforce burst limit
      return { allowed: true, count: 0, transactional: true };
    }
  }

  async releaseReservation(externalUserId: string): Promise<void> {
    const client = this.redisClient.getNativeClient();
    if (!client) {
      return;
    }

    const key = this.key(externalUserId);
    const luaScript = `
      local remaining = redis.call('DECR', KEYS[1])
      if remaining <= 0 then
        redis.call('DEL', KEYS[1])
      end
      return remaining
    `;

    try {
      await client.eval(luaScript, 1, key);
    } catch {
      // Best-effort — burst counter is advisory
    }
  }

  private key(externalUserId: string): string {
    const bucket = Math.floor(Date.now() / CHAT_BURST_WINDOW_MS);
    return `${RedisBurstCounter.KEY_PREFIX}${externalUserId}:${bucket}`;
  }
}
