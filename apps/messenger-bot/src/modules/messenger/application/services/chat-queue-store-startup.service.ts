import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common';
import { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';

@Injectable()
export class ChatQueueStoreStartupService implements OnModuleInit {
  private readonly logger = new Logger(ChatQueueStoreStartupService.name);

  constructor(
    private readonly sharedConfig: MessengerChatSharedConfigService,
    @Inject(REDIS_CLIENT) private readonly redisClient: RedisClientPort,
  ) {}

  onModuleInit(): void {
    const configured = this.sharedConfig.getQueueStore();

    if (!this.sharedConfig.isDistributedQueueEnabled()) {
      this.logger.log('Chat queue store active=memory (in-process debounce)');
      return;
    }

    if (!this.redisClient.isEnabled()) {
      this.logger.warn(
        'Distributed chat queue requires REDIS_ENABLED=true — buffer ops may fail',
      );
      return;
    }

    this.logger.log(
      `Chat queue store active=redis configured=${configured} stuckMs=${this.sharedConfig.getProcessingStuckMs()}`,
    );
  }
}
