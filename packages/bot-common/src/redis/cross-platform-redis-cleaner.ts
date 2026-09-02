import { Logger } from '@nestjs/common';
import { errorMessage } from '../masking/error-message';
import { maskExternalId } from '../masking/mask-external-id';
import type { RedisClientPort } from './redis.client.port';

type Platform = 'messenger' | 'discord' | 'zalo';

/**
 * Per-platform Redis key cleaner for privacy erasure.
 *
 * Deletes chat history, queue buffer, and set keys for ONE platform.
 * Each bot wires this as its own `clearHistory` callback; the backend
 * calls each bot's /privacy/delete endpoint to clear all platforms.
 *
 * Key shapes per platform (parameterized by externalUserId):
 *   History:  chat:history:{id}  (M)  |  chat-history:{platform}:{id}  (D/Z)
 *   Queue:    chat:queue:buffer:{id}  (M legacy)  |  chat:queue:{platform}:buffer:{id}  (D/Z)
 *   Sets:     chat:queue:active-psids  (M)  |  chat:queue:{platform}:active-users  (D/Z)
 *   Flush:    chat:queue:flush  (M)  |  chat:queue:{platform}:flush  (D/Z)
 *   Stuck:    chat:queue:stuck  (M)  |  chat:queue:{platform}:stuck  (D/Z)
 */
export class CrossPlatformRedisCleaner {
  private readonly logger = new Logger(CrossPlatformRedisCleaner.name);

  constructor(
    private readonly redisClient: RedisClientPort,
    private readonly platform: Platform,
  ) {}

  async clean(externalUserId: string): Promise<void> {
    const client = this.redisClient.getNativeClient();
    if (!client || !this.redisClient.isEnabled()) return;

    const p = this.platform;
    const isMessenger = p === 'messenger';
    const prefix = isMessenger ? 'chat:queue:' : `chat:queue:${p}:`;

    const keys = [
      // History
      isMessenger
        ? `chat:history:${externalUserId}`
        : `chat-history:${p}:${externalUserId}`,
      // Queue buffer
      `${prefix}buffer:${externalUserId}`,
      // Queue sets
      isMessenger ? 'chat:queue:active-psids' : `${prefix}active-users`,
      isMessenger ? 'chat:queue:flush' : `${prefix}flush`,
      isMessenger ? 'chat:queue:stuck' : `${prefix}stuck`,
    ];

    try {
      await client.del(...keys);
    } catch (error) {
      this.logger.warn(
        `Redis cleanup failed externalUserId=${maskExternalId(externalUserId)}: ${errorMessage(error, { externalUserId, maxChars: 160 })}`,
      );
    }
  }
}
