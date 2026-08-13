import { Logger } from '@nestjs/common';
import {
  ThrottlerStorageService,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import type { RedisService } from './redis.service';

const INCREMENT_SCRIPT = `
local blockTtl = redis.call('PTTL', KEYS[2])
local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
if blockTtl > 0 then
  return {hits, redis.call('PTTL', KEYS[1]), 1, blockTtl}
end
if hits > tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  hits = 0
end
hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local hitTtl = redis.call('PTTL', KEYS[1])
local isBlocked = 0
local blockDuration = 0
if hits > tonumber(ARGV[2]) then
  redis.call('PSETEX', KEYS[2], ARGV[3], '1')
  isBlocked = 1
  blockDuration = tonumber(ARGV[3])
end
return {hits, hitTtl, isBlocked, blockDuration}
`;

/**
 * Shared throttler storage for multi-pod deployments. Redis is authoritative
 * when configured; an unavailable configured Redis fails closed instead of
 * silently reverting to a per-pod limit.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly fallback = new ThrottlerStorageService();
  private redisFailureLogged = false;

  constructor(private readonly redisService: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const client = this.redisService.getNativeClient();
    if (!this.redisService.isConfiguredEnabled()) {
      return this.fallback.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    }

    if (!client) {
      this.logRedisFailure('Redis is configured but unavailable');
      return this.failClosed(limit);
    }

    try {
      const result = (await client.eval(
        INCREMENT_SCRIPT,
        2,
        this.key(throttlerName, key, 'hits'),
        this.key(throttlerName, key, 'block'),
        String(Math.max(1, ttl)),
        String(Math.max(0, limit)),
        String(Math.max(1, blockDuration)),
      )) as [number, number, number, number];

      return {
        totalHits: Number(result[0]),
        timeToExpire: this.ttlSeconds(result[1]),
        isBlocked: Number(result[2]) === 1,
        timeToBlockExpire: this.ttlSeconds(result[3]),
      };
    } catch (error) {
      this.logRedisFailure(
        `Redis throttler increment failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.failClosed(limit);
    }
  }

  private key(throttlerName: string, key: string, suffix: string): string {
    return `throttler:${throttlerName}:${key}:${suffix}`;
  }

  private ttlSeconds(milliseconds: number): number {
    return Math.max(0, Math.ceil(Number(milliseconds) / 1000));
  }

  private failClosed(limit: number): ThrottlerStorageRecord {
    return {
      totalHits: limit + 1,
      timeToExpire: 1,
      isBlocked: true,
      timeToBlockExpire: 1,
    };
  }

  private logRedisFailure(message: string): void {
    if (!this.redisFailureLogged) {
      this.redisFailureLogged = true;
      this.logger.error(message);
    }
  }
}
