import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common';
import type { Redis } from 'ioredis';

const KEY_PREFIX = 'llm:concurrency:';
const LEASE_PREFIX = ':lease:';
const RETRY_DELAY_MS = 50;
const MAX_RETRIES = 200;
const SLOT_TTL_MS = 60_000;

// Lua script: atomic acquire — INCR counter, PEXPIRE, store lease UUID
const ACQUIRE_SCRIPT = `
local key = KEYS[1]
local lease_key = KEYS[2]
local limit = tonumber(ARGV[1])
local ttl_ms = tonumber(ARGV[2])
local uuid = ARGV[3]

local current = redis.call('INCR', key)
redis.call('PEXPIRE', key, ttl_ms)

if current <= limit then
  redis.call('SET', lease_key, uuid, 'PX', ttl_ms)
  return 1
else
  redis.call('DECR', key)
  return 0
end
`;

// Lua script: atomic release — check lease UUID, DECR counter if match
const RELEASE_SCRIPT = `
local key = KEYS[1]
local lease_key = KEYS[2]
local uuid = ARGV[1]

local stored = redis.call('GET', lease_key)
if stored == uuid then
  redis.call('DEL', lease_key)
  local val = redis.call('DECR', key)
  if val < 0 then
    redis.call('SET', key, 0)
  end
  return 1
else
  return 0
end
`;

@Injectable()
export class RedisConcurrencyLimiter {
  private readonly logger = new Logger(RedisConcurrencyLimiter.name);

  constructor(private readonly redis: Redis) {}

  /**
   * Acquire a global concurrency slot with owner-safe lease.
   * Returns a release function that only releases if the lease UUID matches.
   * Throws if cannot acquire within max retries.
   */
  async acquire(key: string, limit: number): Promise<() => Promise<void>> {
    const redisKey = `${KEY_PREFIX}${key}`;
    const uuid = randomUUID();
    const leaseKey = `${redisKey}${LEASE_PREFIX}${uuid}`;

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const result = await this.redis.eval(
          ACQUIRE_SCRIPT,
          2,
          redisKey,
          leaseKey,
          String(limit),
          String(SLOT_TTL_MS),
          uuid,
        );

        if (result === 1) {
          return () => this.release(redisKey, leaseKey, uuid);
        }
      } catch (err) {
        this.logger.warn(`Redis acquire error: ${errorMessage(err)}`);
      }

      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    throw new Error(
      `Global LLM concurrency limit (${limit}) exceeded after ${MAX_RETRIES} retries`,
    );
  }

  private async release(
    redisKey: string,
    leaseKey: string,
    uuid: string,
  ): Promise<void> {
    try {
      const result = await this.redis.eval(
        RELEASE_SCRIPT,
        2,
        redisKey,
        leaseKey,
        uuid,
      );

      if (result === 0) {
        this.logger.warn(
          `Stale release detected for slot — lease UUID mismatch (likely expired or crashed)`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Failed to release concurrency slot: ${errorMessage(err)}`,
      );
    }
  }
}
