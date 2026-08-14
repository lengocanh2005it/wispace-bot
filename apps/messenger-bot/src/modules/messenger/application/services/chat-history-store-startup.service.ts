import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common';
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

    // Fail closed: the configured contract (Redis history for multi-pod
    // coherence) must not silently degrade to per-process memory.
    if (configured === 'redis' && !this.redisClient.isEnabled()) {
      throw new Error(
        'CHAT_HISTORY_STORE=redis but REDIS_ENABLED=false — refusing to silently fall back to memory. Enable Redis or set CHAT_HISTORY_STORE=memory.',
      );
    }

    if (configured === 'redis' && active === 'memory') {
      throw new Error(
        'CHAT_HISTORY_STORE=redis but Redis client is unavailable — refusing to silently fall back to memory. Check Redis connectivity or set CHAT_HISTORY_STORE=memory.',
      );
    }

    this.logger.log(
      `Chat history store active=${active} configured=${configured} ttlMs=${this.sharedConfig.getHistoryTtlMs()} maxMessages=${this.sharedConfig.getHistoryMaxMessages()}`,
    );
  }
}
