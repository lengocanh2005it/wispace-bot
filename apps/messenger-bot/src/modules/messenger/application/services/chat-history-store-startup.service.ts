import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  REDIS_CLIENT,
  type RedisClientPort,
} from '@messenger/infrastructure/redis/redis.client.port';
import { ChatHistoryStoreResolver } from '../../infrastructure/persistence/chat-history.store.resolver';
import { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';

@Injectable()
export class ChatHistoryStoreStartupService implements OnModuleInit {
  private readonly logger = new Logger(ChatHistoryStoreStartupService.name);

  constructor(
    private readonly sharedConfig: MessengerChatSharedConfigService,
    @Inject(REDIS_CLIENT) private readonly redisClient: RedisClientPort,
    private readonly chatHistoryStoreResolver: ChatHistoryStoreResolver,
  ) {}

  onModuleInit(): void {
    const configured = this.sharedConfig.getHistoryStore();
    const active = this.chatHistoryStoreResolver.resolveStoreKind();

    if (configured === 'redis' && !this.redisClient.isEnabled()) {
      this.logger.warn(
        'CHAT_HISTORY_STORE=redis but REDIS_ENABLED=false — using memory fallback',
      );
      return;
    }

    if (configured === 'redis' && active === 'memory') {
      this.logger.warn(
        'CHAT_HISTORY_STORE=redis but Redis client unavailable — using memory fallback',
      );
      return;
    }

    this.logger.log(
      `Chat history store active=${active} configured=${configured} ttlMs=${this.sharedConfig.getHistoryTtlMs()} maxMessages=${this.sharedConfig.getHistoryMaxMessages()}`,
    );
  }
}
