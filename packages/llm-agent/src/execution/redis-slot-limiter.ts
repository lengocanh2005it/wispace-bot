import { randomUUID } from 'crypto';
import { errorMessage } from '@wispace/bot-common';
import type { Redis } from 'ioredis';

export interface SlotLogger {
  warn(message: string): void;
}

export interface SlotMetrics {
  incrementCounter(name: string, labels?: Record<string, string>): void;
}

/**
 * Distributed global LLM concurrency slot with owner-safe leases.
 *
 * Each acquired slot has a UUID fencing token. Release is atomic — only
 * the current owner can release its slot; stale releases are harmless no-ops.
 * Acquire uses a Lua script for atomic INCR + PEXPIRE + lease store.
 *
 * Same key/algorithm as Messenger's RedisConcurrencyLimiter, so all pods
 * of all bots share one aggregate provider budget.
 */
const RETRY_DELAY_MS = 50;
const MAX_RETRIES = 200;
const SLOT_TTL_MS = 60_000;
const LEASE_PREFIX = ':lease:';

// Lua script: atomic acquire — INCR counter, PEXPIRE, store lease UUID
// Returns: 1 if acquired (current <= limit), 0 if limit exceeded, -1 on error
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
// Returns: 1 if released, 0 if lease mismatch (stale), -1 on error
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

export async function acquireRedisSlot(
  redis: Redis,
  key: string,
  limit: number,
  logger: SlotLogger,
  metrics?: SlotMetrics,
): Promise<() => Promise<void>> {
  const uuid = randomUUID();
  const leaseKey = `${key}${LEASE_PREFIX}${uuid}`;

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const result = await redis.eval(
        ACQUIRE_SCRIPT,
        2,
        key,
        leaseKey,
        String(limit),
        String(SLOT_TTL_MS),
        uuid,
      );

      if (result === 1) {
        metrics?.incrementCounter('llm_concurrency_acquired');
        return () =>
          releaseRedisSlot(redis, key, leaseKey, uuid, logger, metrics);
      }

      metrics?.incrementCounter('llm_concurrency_rejected');
    } catch (err) {
      logger.warn(`Redis acquire error: ${errorMessage(err)}`);
      metrics?.incrementCounter('llm_concurrency_rejected');
    }

    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }

  throw new Error(
    `Global LLM concurrency limit (${limit}) exceeded after ${MAX_RETRIES} retries`,
  );
}

async function releaseRedisSlot(
  redis: Redis,
  key: string,
  leaseKey: string,
  uuid: string,
  logger: SlotLogger,
  metrics?: SlotMetrics,
): Promise<void> {
  try {
    const result = await redis.eval(RELEASE_SCRIPT, 2, key, leaseKey, uuid);

    if (result === 0) {
      // Lease mismatch — stale release, harmless no-op
      metrics?.incrementCounter('llm_concurrency_stale_release');
    } else {
      metrics?.incrementCounter('llm_concurrency_released');
    }
  } catch (err) {
    logger.warn(`Failed to release concurrency slot: ${errorMessage(err)}`);
    metrics?.incrementCounter('llm_concurrency_release_error');
  }
}
