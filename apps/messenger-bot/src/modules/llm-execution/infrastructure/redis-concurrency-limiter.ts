import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

const KEY_PREFIX = 'llm:concurrency:';
const RETRY_DELAY_MS = 50;
const MAX_RETRIES = 200;

@Injectable()
export class RedisConcurrencyLimiter {
  private readonly logger = new Logger(RedisConcurrencyLimiter.name);

  constructor(private readonly redis: Redis) {}

  /**
   * Acquire a global concurrency slot. Returns a release function.
   * Throws if cannot acquire within max retries.
   */
  async acquire(key: string, limit: number): Promise<() => Promise<void>> {
    const redisKey = `${KEY_PREFIX}${key}`;

    for (let i = 0; i < MAX_RETRIES; i++) {
      const current = await this.redis.incr(redisKey);
      await this.redis.pexpire(redisKey, 60_000);

      if (current <= limit) {
        return () => this.release(redisKey);
      }

      await this.redis.decr(redisKey);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    throw new Error(
      `Global LLM concurrency limit (${limit}) exceeded after ${MAX_RETRIES} retries`,
    );
  }

  private async release(redisKey: string): Promise<void> {
    try {
      const val = await this.redis.decr(redisKey);
      if (val < 0) {
        await this.redis.set(redisKey, 0);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to release concurrency slot: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
