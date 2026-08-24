import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common';
import type { Redis } from 'ioredis';

const KEY_PREFIX = 'llm:concurrency:';
const LEASE_PREFIX = ':lease:';
const RETRY_DELAY_MS = 50;
const MAX_RETRIES = 200;
const DEFAULT_LEASE_MS = 60_000;

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
   * Throws if cannot acquire within max retries or if signal aborts.
   */
  async acquire(
    key: string,
    limit: number,
    options?: { signal?: AbortSignal; leaseMs?: number },
  ): Promise<() => Promise<void>> {
    const { signal, leaseMs = DEFAULT_LEASE_MS } = options ?? {};
    const redisKey = `${KEY_PREFIX}${key}`;
    const uuid = randomUUID();
    const leaseKey = `${redisKey}${LEASE_PREFIX}${uuid}`;

    // Reject early if caller already aborted
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    for (let i = 0; i < MAX_RETRIES; i++) {
      // Check cancellation between retries
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      try {
        const result = await this.redis.eval(
          ACQUIRE_SCRIPT,
          2,
          redisKey,
          leaseKey,
          String(limit),
          String(leaseMs),
          uuid,
        );

        if (result === 1) {
          return () => this.release(redisKey, leaseKey, uuid);
        }
      } catch (err) {
        // AbortError from signal abort during redis.eval
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw err;
        }
        this.logger.warn(`Redis acquire error: ${errorMessage(err)}`);
      }

      // Abort-aware sleep — reject if signal fires during delay
      await this.abortableSleep(RETRY_DELAY_MS, signal);
    }

    throw new Error(
      `Global LLM concurrency limit (${limit}) exceeded after ${MAX_RETRIES} retries`,
    );
  }

  /**
   * Sleep that rejects early if the provided AbortSignal fires.
   */
  private abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true },
      );
    });
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
