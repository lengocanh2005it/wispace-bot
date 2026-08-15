import { errorMessage } from '@wispace/bot-common';
import type { Redis } from 'ioredis';

export interface SlotLogger {
  warn(message: string): void;
}

/**
 * Distributed global LLM concurrency slot — same key/algorithm as the
 * Messenger app's `RedisConcurrencyLimiter` (`llm:concurrency:*`), so all
 * pods of all bots share one aggregate provider budget when
 * `LLM_GLOBAL_CONCURRENCY_ENABLED=true`.
 */
const RETRY_DELAY_MS = 50;
const MAX_RETRIES = 200;
const SLOT_TTL_MS = 60_000;

export async function acquireRedisSlot(
  redis: Redis,
  key: string,
  limit: number,
  logger: SlotLogger,
): Promise<() => Promise<void>> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const current = await redis.incr(key);
    await redis.pexpire(key, SLOT_TTL_MS);

    if (current <= limit) {
      return () => releaseRedisSlot(redis, key, logger);
    }

    await redis.decr(key);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }

  throw new Error(
    `Global LLM concurrency limit (${limit}) exceeded after ${MAX_RETRIES} retries`,
  );
}

async function releaseRedisSlot(
  redis: Redis,
  key: string,
  logger: SlotLogger,
): Promise<void> {
  try {
    const val = await redis.decr(key);
    if (val < 0) {
      await redis.set(key, 0);
    }
  } catch (err) {
    logger.warn(`Failed to release concurrency slot: ${errorMessage(err)}`);
  }
}
