import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatRuntimeConfig } from '@wispace/chat-agent';
import { readEnvPositiveInt } from '@messenger/shared/config/env-helpers';
import type {
  ChatHistoryStoreKind,
  ChatQueueStoreKind,
} from '../../domain/entities/messenger-store.types';

@Injectable()
export class MessengerChatSharedConfigService {
  private readonly runtimeConfig: ChatRuntimeConfig;

  constructor(
    private readonly configService: ConfigService,
    @Optional() runtimeConfig?: ChatRuntimeConfig,
  ) {
    this.runtimeConfig = runtimeConfig ?? new ChatRuntimeConfig(configService);
  }

  isSharedQueueEnabled(): boolean {
    return this.runtimeConfig.legacyQueueShared;
  }

  isDistributedQueueEnabled(): boolean {
    return this.getQueueStore() !== 'memory';
  }

  getQueueStore(): ChatQueueStoreKind {
    return this.runtimeConfig.queueMode();
  }

  getHistoryStore(): ChatHistoryStoreKind {
    return this.runtimeConfig.history('CHAT_HISTORY_').store;
  }

  getProcessingStuckMs(): number {
    return this.runtimeConfig.processingStuckMs;
  }

  getHistoryTtlMs(): number {
    return this.runtimeConfig.history('CHAT_HISTORY_').ttlMs;
  }

  /** #660: how long a pending in-chat privacy confirmation stays valid. */
  getPrivacyConfirmTtlMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'PRIVACY_CONFIRM_TTL_MS',
      30 * 60 * 1000,
    );
  }

  getHistoryMaxMessages(): number {
    return this.runtimeConfig.history('CHAT_HISTORY_').maxMessages;
  }

  getHistoryMaxUsers(): number {
    return this.runtimeConfig.history('CHAT_HISTORY_').maxUsers;
  }

  getQueueStaleTtlMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'CHAT_QUEUE_STALE_TTL_MS',
      60 * 60 * 1000,
    );
  }

  getQueueCleanupIntervalMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'CHAT_QUEUE_CLEANUP_INTERVAL_MS',
      15 * 60 * 1000,
    );
  }
}
