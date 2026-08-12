import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common';
import { ConfigService } from '@nestjs/config';
import { DebounceChatQueue } from '@wispace/chat-queue-core';
import type { ChatQueueBatch } from '@wispace/chat-queue-core';
import type { EnqueueChatMessageInput } from '../../domain/entities/messenger-chat-queue.types';
import { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import {
  capMergedChatUserText,
  mergeChatUserTexts,
} from '@messenger/shared/utils/messenger-text.utils';
import { ChatRateLimitConfigService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit-config.service';
import { CHAT_QUEUE_STORE } from '../../domain/repositories/chat-queue.store.port';
import type { ChatQueueStorePort } from '../../domain/repositories/chat-queue.store.port';
import { MessengerOutboundService } from './messenger-outbound.service';
import { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';
import { MessengerChatProcessorService } from './messenger-chat-processor.service';

const DISTRIBUTED_ENQUEUE_MAX_ATTEMPTS = 3;
const DISTRIBUTED_ENQUEUE_RETRY_DELAY_MS = 25;

export type { EnqueueChatMessageInput };

interface MemoryQueueContext {
  userId?: number;
  linkContext?: MessengerLinkContext;
}

@Injectable()
export class MessengerChatEnqueueService implements OnModuleDestroy {
  private readonly logger = new Logger(MessengerChatEnqueueService.name);
  private readonly debounceQueue: DebounceChatQueue<MemoryQueueContext>;
  private readonly sharedFlushTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly configService: ConfigService,
    private readonly outbound: MessengerOutboundService,
    private readonly processor: MessengerChatProcessorService,
    private readonly chatRateLimitConfig: ChatRateLimitConfigService,
    private readonly sharedConfig: MessengerChatSharedConfigService,
    @Optional()
    @Inject(CHAT_QUEUE_STORE)
    private readonly chatQueueStore?: ChatQueueStorePort,
  ) {
    // 0 = no cap (DebounceChatQueue maps 0 to its default 20, so pass
    // MAX_SAFE_INTEGER to disable the pending-message cap entirely).
    const maxPendingSize =
      configService.get<string>('CHAT_MAX_PENDING_MESSAGES') === '0'
        ? Number.MAX_SAFE_INTEGER
        : Math.max(
            1,
            Number(configService.get<string>('CHAT_MAX_PENDING_MESSAGES')) ||
              20,
          );

    this.debounceQueue = new DebounceChatQueue<MemoryQueueContext>(
      {
        getDebounceMs: () => this.getDebounceMs(),
        staleTtlMs: sharedConfig.getQueueStaleTtlMs(),
        cleanupIntervalMs: sharedConfig.getQueueCleanupIntervalMs(),
        maxPendingSize,
      },
      (batch) => this.handleMemoryFlush(batch),
      {
        onPendingQueued: (externalUserId, _text, pendingCount) => {
          if (pendingCount === 1) {
            void this.outbound
              .sendTextViaPsid({
                psid: externalUserId,
                text: 'Đang xử lý tin nhắn trước, vui lòng chờ trong giây lát...',
                messageType: 'PENDING_FEEDBACK',
              })
              .catch((error) => {
                this.logger.error(
                  `Failed to send pending feedback to psid=${externalUserId}: ${errorMessage(
                    error,
                  )}`,
                );
              });
          }
        },
        onPendingDropped: (externalUserId, droppedCount) => {
          this.logger.warn(
            `Dropped ${droppedCount} pending message(s) for ${externalUserId} (cap exceeded)`,
          );
        },
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.debounceQueue.destroy();

    for (const timer of this.sharedFlushTimers.values()) {
      clearTimeout(timer);
    }
    this.sharedFlushTimers.clear();
  }

  async enqueue(input: EnqueueChatMessageInput): Promise<void> {
    const text = input.userText.trim();
    if (!text) {
      return;
    }

    void this.outbound.sendSenderActionOptional(input.psid, 'mark_seen');

    if (this.isDistributedMode()) {
      await this.enqueueDistributed(input, text);
      return;
    }

    const memoryContext: MemoryQueueContext = {};
    if (input.userId !== undefined) {
      memoryContext.userId = input.userId;
    }
    if (input.linkContext !== undefined) {
      memoryContext.linkContext = input.linkContext;
    }

    this.debounceQueue.enqueue({
      externalUserId: input.psid,
      text,
      context: memoryContext,
      idempotencyKey: input.idempotencyKey,
    });
  }

  private async handleMemoryFlush(
    batch: ChatQueueBatch<MemoryQueueContext>,
  ): Promise<void> {
    const mergedText = capMergedChatUserText(
      mergeChatUserTexts(batch.texts),
      this.getMergedTextMaxChars(),
    );

    await this.processor.process({
      psid: batch.externalUserId,
      mergedText,
      userId: batch.context?.userId,
      linkContext: batch.context?.linkContext,
      idempotencyKey: batch.idempotencyKey,
    });
  }

  private async enqueueDistributed(
    input: EnqueueChatMessageInput,
    text: string,
  ): Promise<void> {
    let lastError: unknown;

    for (
      let attempt = 1;
      attempt <= DISTRIBUTED_ENQUEUE_MAX_ATTEMPTS;
      attempt += 1
    ) {
      try {
        await this.getChatQueueStore().appendChatBuffer({
          psid: input.psid,
          userText: text,
          userId: input.userId,
          linkContext: input.linkContext,
          idempotencyKey: input.idempotencyKey,
          debounceMs: this.getDebounceMs(),
        });
        this.scheduleDistributedFlush(input.psid);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < DISTRIBUTED_ENQUEUE_MAX_ATTEMPTS) {
          this.logger.warn(
            `Distributed chat enqueue retry psid=${input.psid} attempt=${attempt}/${DISTRIBUTED_ENQUEUE_MAX_ATTEMPTS}: ${errorMessage(
              error,
            )}`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, DISTRIBUTED_ENQUEUE_RETRY_DELAY_MS),
          );
        }
      }
    }

    this.logger.error(
      `Distributed chat enqueue failed psid=${input.psid} attempts=${DISTRIBUTED_ENQUEUE_MAX_ATTEMPTS}: ${errorMessage(
        lastError,
      )}`,
    );
    throw lastError;
  }

  private scheduleDistributedFlush(psid: string): void {
    const existing = this.sharedFlushTimers.get(psid);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.sharedFlushTimers.delete(psid);
      void this.processor.flushReady(psid).catch((error) => {
        this.logger.error(
          `Distributed chat flush failed psid=${psid}: ${errorMessage(error)}`,
        );
      });
    }, this.getDebounceMs());
    timer.unref?.();

    this.sharedFlushTimers.set(psid, timer);
  }

  private getChatQueueStore(): ChatQueueStorePort {
    if (!this.chatQueueStore) {
      throw new Error(
        'CHAT_QUEUE_STORE not available — distributed mode requires Redis',
      );
    }
    return this.chatQueueStore;
  }

  private isDistributedMode(): boolean {
    return this.sharedConfig.isDistributedQueueEnabled() === true;
  }

  private getMergedTextMaxChars(): number {
    return this.chatRateLimitConfig.getSettings().mergedTextMaxChars;
  }

  private getDebounceMs(): number {
    const parsed = Number(
      this.configService.get<string>('CHAT_DEBOUNCE_MS') ?? 2000,
    );
    if (!Number.isFinite(parsed) || parsed < 0) {
      return 2000;
    }

    return Math.min(Math.floor(parsed), 10_000);
  }
}
