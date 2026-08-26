import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';

@Injectable()
export class ChatQueueStoreStartupService implements OnModuleInit {
  private readonly logger = new Logger(ChatQueueStoreStartupService.name);

  constructor(
    private readonly sharedConfig: MessengerChatSharedConfigService,
    @Inject(REDIS_CLIENT) private readonly redisClient: RedisClientPort,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const configured = this.sharedConfig.getQueueStore();
    const nodeEnv = this.configService.get<string>('NODE_ENV');

    if (
      (nodeEnv ?? process.env.NODE_ENV)?.trim().toLowerCase() ===
        'production' &&
      !this.sharedConfig.isDistributedQueueEnabled()
    ) {
      throw new Error('CHAT_QUEUE_STORE=redis is required in production');
    }

    if (!this.sharedConfig.isDistributedQueueEnabled()) {
      this.logger.log('Chat queue store active=memory (in-process debounce)');
      return;
    }

    if (
      !this.redisClient.isEnabled() ||
      this.redisClient.getNativeClient() === null
    ) {
      throw new Error('Redis chat queue unavailable');
    }

    this.logger.log(
      `Chat queue store active=redis configured=${configured} stuckMs=${this.sharedConfig.getProcessingStuckMs()}`,
    );
  }
}
