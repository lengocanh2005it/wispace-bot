import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
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

  async onModuleInit(): Promise<void> {
    const configured = this.sharedConfig.getHistoryStore();

    if (configured !== 'redis') {
      this.logActiveStore(configured);
      return;
    }

    // RedisService connects asynchronously (ping in onModuleInit) — wait
    // briefly so a slow-but-healthy Redis boot is not mistaken for an outage.
    if (!this.redisClient.getNativeClient()) {
      await this.waitForRedisClient();
    }
    const active = this.chatHistoryStoreResolver.resolveStoreKind();

    // Fail closed: the configured contract (Redis history for multi-pod
    // coherence) must not silently degrade to per-process memory.
    if (!this.redisClient.isEnabled()) {
      throw new Error(
        'CHAT_HISTORY_STORE=redis but REDIS_ENABLED=false — refusing to silently fall back to memory. Enable Redis or set CHAT_HISTORY_STORE=memory.',
      );
    }

    if (active === 'memory') {
      throw new Error(
        'CHAT_HISTORY_STORE=redis but Redis client is unavailable — refusing to silently fall back to memory. Check Redis connectivity or set CHAT_HISTORY_STORE=memory.',
      );
    }

    this.logActiveStore(configured, active);
  }

  private async waitForRedisClient(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (this.redisClient.getNativeClient()) {
        return;
      }
    }
  }

  private logActiveStore(configured: string, active?: string): void {
    this.logger.log(
      `Chat history store active=${active ?? this.chatHistoryStoreResolver.resolveStoreKind()} configured=${configured} ttlMs=${this.sharedConfig.getHistoryTtlMs()} maxMessages=${this.sharedConfig.getHistoryMaxMessages()}`,
    );
  }
}
