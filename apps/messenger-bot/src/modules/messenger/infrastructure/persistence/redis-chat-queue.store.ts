import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisChatQueueStore as SharedRedisChatQueueStore } from '@wispace/chat-agent';
import { REDIS_CLIENT } from '@wispace/bot-common/redis';
import type { RedisClientPort } from '@wispace/bot-common/redis';
import { BotMetricsService } from '@wispace/bot-metrics';
import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import type {
  AppendChatBufferInput,
  ChatQueueBufferSnapshot,
  CompleteChatBufferInput,
} from '../../domain/entities/chat-shared-state.types';
import type { ChatQueueStorePort } from '../../domain/repositories/chat-queue.store.port';

/** Messenger adapter preserving the legacy Redis keys and app-level types. */
@Injectable()
export class RedisChatQueueStore implements ChatQueueStorePort {
  private readonly sharedStore: SharedRedisChatQueueStore;

  constructor(
    @Inject(REDIS_CLIENT) redisClient: RedisClientPort,
    configService: ConfigService,
    @Optional() metrics?: BotMetricsService,
  ) {
    this.sharedStore = new SharedRedisChatQueueStore(
      redisClient,
      configService,
      {
        platform: 'messenger',
        legacyKeys: true,
        onRecoveryOutcome: (outcome) =>
          metrics?.incChatFlushRecovery('messenger', outcome),
      },
    );
  }

  isAvailable(): boolean {
    return this.sharedStore.isAvailable();
  }

  appendChatBuffer(input: AppendChatBufferInput): Promise<void> {
    return this.sharedStore.appendChatBuffer({
      externalUserId: input.psid,
      userText: input.userText,
      userId: input.userId,
      context: input.linkContext as Record<string, unknown> | undefined,
      idempotencyKey: input.idempotencyKey,
      debounceMs: input.debounceMs,
    });
  }

  async claimReadyBuffer(
    psid: string,
    debounceMs: number,
    processingStuckMs: number,
  ): Promise<ChatQueueBufferSnapshot | null> {
    const snapshot = await this.sharedStore.claimReadyBuffer(
      psid,
      debounceMs,
      processingStuckMs,
    );
    if (!snapshot) {
      return null;
    }
    return {
      psid: snapshot.externalUserId,
      texts: snapshot.texts,
      leaseToken: snapshot.leaseToken,
      lastIdempotencyKey: snapshot.lastIdempotencyKey,
      retryCount: snapshot.retryCount,
      userId: snapshot.userId,
      linkContext: snapshot.context as MessengerLinkContext | undefined,
      droppedNoticePending: snapshot.droppedNoticePending,
    };
  }

  completeChatBuffer(input: CompleteChatBufferInput): Promise<boolean> {
    return this.sharedStore.completeChatBuffer({
      externalUserId: input.psid,
      debounceMs: input.debounceMs,
      leaseToken: input.leaseToken,
    });
  }

  clearChatBuffer(psid: string): Promise<boolean> {
    return this.sharedStore.clearChatBuffer(psid);
  }

  listPsidsReadyForFlush(limit: number): Promise<string[]> {
    return this.sharedStore.listReadyExternalUserIds(limit);
  }

  scheduleRetryFlush(
    psid: string,
    retryDelayMs: number,
    leaseToken: string,
  ): Promise<boolean> {
    return this.sharedStore.scheduleRetryFlush(psid, retryDelayMs, leaseToken);
  }
}
