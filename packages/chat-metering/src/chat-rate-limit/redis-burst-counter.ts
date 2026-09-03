import type { RedisClientPort } from '@wispace/bot-common/redis';
import { CHAT_BURST_WINDOW_MS } from './memory-burst-counter';
import type { BurstCounterPort } from './types';

export const CHAT_BURST_KEY_TTL_SECONDS = 120;

export interface RedisBurstCounterOptions {
  platform?: string;
  /** Read and atomically migrate pre-platform Messenger keys on first use. */
  legacyRead?: boolean;
}

export function buildRedisBurstKey(
  platform: string,
  externalUserId: string,
  bucket: number,
): string {
  return `burst:${platform}:${externalUserId}:${bucket}`;
}

export function buildLegacyRedisBurstKey(
  externalUserId: string,
  bucket: number,
): string {
  return `burst:${externalUserId}:${bucket}`;
}

/**
 * Redis-backed burst counter. Redis is an advisory fast path; the quota
 * transaction in Postgres remains the final authority (#609).
 */
export class RedisBurstCounter implements BurstCounterPort {
  constructor(
    private readonly redisClient: RedisClientPort,
    private readonly options: RedisBurstCounterOptions = {},
  ) {}

  isAvailable(): boolean {
    return (
      this.redisClient.isEnabled() &&
      this.redisClient.getNativeClient() !== null
    );
  }

  async getBurstCount(externalUserId: string): Promise<number> {
    const client = this.redisClient.getNativeClient();
    if (!client) return 0;

    try {
      const bucket = this.currentBucket();
      const current = await client.get(this.key(externalUserId, bucket));
      if (current !== null) return this.safeCount(current);
      if (this.legacyRead) {
        return this.safeCount(
          (await client.get(
            buildLegacyRedisBurstKey(externalUserId, bucket),
          )) ?? '0',
        );
      }
      return 0;
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
    if (!client) return { allowed: true, count: 0, transactional: true };

    const bucket = this.currentBucket();
    const key = this.key(externalUserId, bucket);
    const legacyKey = this.legacyRead
      ? buildLegacyRedisBurstKey(externalUserId, bucket)
      : key;
    const luaScript = `
      if KEYS[1] ~= KEYS[2] and redis.call('EXISTS', KEYS[1]) == 0 then
        local legacy = redis.call('GET', KEYS[2])
        if legacy then
          redis.call('SET', KEYS[1], legacy)
          local ttl = redis.call('PTTL', KEYS[2])
          if ttl > 0 then
            redis.call('PEXPIRE', KEYS[1], ttl)
          else
            redis.call('EXPIRE', KEYS[1], ARGV[1])
          end
          redis.call('DEL', KEYS[2])
        end
      end
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
      if count > tonumber(ARGV[2]) then
        redis.call('DECR', KEYS[1])
        return {0, count - 1}
      end
      return {1, count}
    `;

    try {
      const result = (await client.eval(
        luaScript,
        2,
        key,
        legacyKey,
        String(CHAT_BURST_KEY_TTL_SECONDS),
        String(limit),
      )) as number[];
      return {
        allowed: Number(result[0]) === 1,
        count: Number(result[1] ?? 0),
        transactional: false,
      };
    } catch {
      // Redis unavailable — let Postgres reserve transaction enforce burst
      return { allowed: true, count: 0, transactional: true };
    }
  }

  async releaseReservation(externalUserId: string): Promise<void> {
    const client = this.redisClient.getNativeClient();
    if (!client) return;

    const key = this.key(externalUserId, this.currentBucket());
    const luaScript = `
      local remaining = redis.call('DECR', KEYS[1])
      if remaining <= 0 then redis.call('DEL', KEYS[1]) end
      return remaining
    `;

    try {
      await client.eval(luaScript, 1, key);
    } catch {
      // Best-effort — burst counter is advisory
    }
  }

  private get platform(): string {
    return this.options.platform ?? 'messenger';
  }

  private get legacyRead(): boolean {
    return this.options.legacyRead ?? this.platform === 'messenger';
  }

  private currentBucket(): number {
    return Math.floor(Date.now() / CHAT_BURST_WINDOW_MS);
  }

  private key(externalUserId: string, bucket: number): string {
    return buildRedisBurstKey(this.platform, externalUserId, bucket);
  }

  private safeCount(raw: string): number {
    const count = Number(raw);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  }
}
