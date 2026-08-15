import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  readEnvBoolean,
  readEnvPositiveInt,
} from '@messenger/shared/config/env-helpers';
import type {
  ChatHistoryStoreKind,
  ChatQueueStoreKind,
} from '../../domain/entities/messenger-store.types';

@Injectable()
export class MessengerChatSharedConfigService {
  constructor(private readonly configService: ConfigService) {}

  isSharedQueueEnabled(): boolean {
    return readEnvBoolean(this.configService, 'CHAT_QUEUE_SHARED', false);
  }

  isDistributedQueueEnabled(): boolean {
    return this.getQueueStore() !== 'memory';
  }

  getQueueStore(): ChatQueueStoreKind {
    const raw = this.configService
      .get<string>('CHAT_QUEUE_STORE')
      ?.trim()
      .toLowerCase();
    if (raw === 'memory' || raw === 'redis') return raw;
    if (this.isSharedQueueEnabled()) return 'redis';
    return 'memory';
  }

  getHistoryStore(): ChatHistoryStoreKind {
    const raw = this.configService
      .get<string>('CHAT_HISTORY_STORE')
      ?.trim()
      .toLowerCase();
    if (raw === 'memory' || raw === 'redis') return raw;
    if (this.isSharedQueueEnabled()) return 'redis';
    return 'memory';
  }

  getProcessingStuckMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'CHAT_QUEUE_PROCESSING_STUCK_MS',
      300_000,
    );
  }

  getHistoryTtlMs(): number {
    return readEnvPositiveInt(
      this.configService,
      'CHAT_HISTORY_TTL_MS',
      30 * 60 * 1000,
    );
  }

  getHistoryMaxMessages(): number {
    return readEnvPositiveInt(
      this.configService,
      'CHAT_HISTORY_MAX_MESSAGES',
      12,
    );
  }

  getHistoryMaxUsers(): number {
    return readEnvPositiveInt(
      this.configService,
      'CHAT_HISTORY_MAX_USERS',
      10_000,
    );
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
