import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CLIENT } from '@wispace/bot-common';
import type { RedisClientPort } from '@wispace/bot-common';
import {
  CHAT_BURST_KEY_TTL_SECONDS,
  CHAT_BURST_WINDOW_MS,
} from '../../domain/entities/chat-burst.types';
import type { ChatBurstCounterPort } from '../../domain/repositories/chat-burst-counter.port';

@Injectable()
export class RedisChatBurstCounter implements ChatBurstCounterPort {
  private static readonly KEY_PREFIX = 'burst:';

  private readonly logger = new Logger(RedisChatBurstCounter.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redisClient: RedisClientPort,
  ) {}

  isAvailable(): boolean {
    return (
      this.redisClient.isEnabled() &&
      this.redisClient.getNativeClient() !== null
    );
  }

  async getBurstCount(psid: string): Promise<number> {
    const client = this.redisClient.getNativeClient();
    if (!client) {
      return 0;
    }

    try {
      const raw = await client.get(this.key(psid));
      return Number(raw ?? 0);
    } catch (error) {
      this.logger.warn(
        `Redis burst read failed psid=${psid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 0;
    }
  }

  async tryReserveBurst(
    psid: string,
    limit: number,
  ): Promise<{ allowed: boolean; count: number }> {
    const client = this.redisClient.getNativeClient();
    if (!client) {
      return { allowed: true, count: 0 };
    }

    const key = this.key(psid);
    // Atomically INCR, set TTL on first write, DECR+deny if over limit.
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
      return { allowed: result[0] === 1, count: result[1] ?? 0 };
    } catch (error) {
      this.logger.warn(
        `Redis burst tryReserve failed psid=${psid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { allowed: false, count: limit };
    }
  }

  async releaseReservation(psid: string): Promise<void> {
    const client = this.redisClient.getNativeClient();
    if (!client) {
      return;
    }

    const key = this.key(psid);

    try {
      const raw = await client.get(key);
      const current = Number(raw ?? 0);
      if (current <= 1) {
        await client.del(key);
        return;
      }

      await client.decr(key);
    } catch (error) {
      this.logger.warn(
        `Redis burst decrement failed psid=${psid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private key(psid: string): string {
    const bucket = Math.floor(Date.now() / CHAT_BURST_WINDOW_MS);
    return `${RedisChatBurstCounter.KEY_PREFIX}${psid}:${bucket}`;
  }
}
