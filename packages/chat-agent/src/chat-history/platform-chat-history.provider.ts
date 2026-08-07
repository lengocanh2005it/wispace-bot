import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT } from '@wispace/bot-common';
import type { PlatformChatHistoryOptions } from '../agent/platform-agent.types';
import { PlatformChatHistoryService } from './platform-chat-history.service';

export type CreatePlatformChatHistoryServiceOptions =
  PlatformChatHistoryOptions;

/**
 * NestJS provider factory for `PlatformChatHistoryService` — replaces the
 * near-identical `useFactory` blocks in the Messenger, Discord and Zalo
 * modules (differ only by env/key prefix). Redis client is optional: both
 * `RedisClientPort` (Messenger/Discord) and `RedisService` (Zalo) satisfy
 * the structural `{ getNativeClient(): unknown }` shape.
 */
export function createPlatformChatHistoryServiceProvider(
  options: CreatePlatformChatHistoryServiceOptions,
): Provider {
  return {
    provide: PlatformChatHistoryService,
    useFactory: (
      configService: ConfigService,
      redisClient?: { getNativeClient(): unknown } | null,
    ) => new PlatformChatHistoryService(configService, options, redisClient),
    inject: [ConfigService, { token: REDIS_CLIENT, optional: true }],
  };
}
