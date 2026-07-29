import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DebounceChatQueue } from '@wispace/chat-queue-core';
import type { ChatQueueBatch } from '@wispace/chat-queue-core';
import { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import {
  capMergedChatUserText,
  mergeChatUserTexts,
} from '@messenger/shared/utils/messenger-text.utils';
import { ChatRateLimitService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit.service';
import { MESSENGER_REPOSITORY } from '../../domain/repositories/messenger.repository.port';
import type { MessengerRepositoryPort } from '../../domain/repositories/messenger.repository.port';
import { CHAT_QUEUE_STORE } from '../../domain/repositories/chat-queue.store.port';
import type { ChatQueueStorePort } from '../../domain/repositories/chat-queue.store.port';
import { MessengerAgentService } from '../agent/messenger-agent.service';
import type { ChatQuotaCheckResult } from '@messenger/modules/chat-rate-limit/domain/entities/chat-quota.types';
import {
  buildChatQuotaDenyMessage,
  buildChatQuotaRemainingHintMessage,
  shouldShowQuotaRemainingHint,
} from '../messages/chat-quota.messages';
import { CHAT_HISTORY_STORE } from '../../domain/repositories/chat-history.store.port';
import type { ChatHistoryStorePort } from '../../domain/repositories/chat-history.store.port';
import { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';
import { readMessengerBubbleLimits } from '../utils/messenger-bubble-config.utils';
import {
  MessengerOutboundService,
  MessengerPartialSendError,
} from './messenger-outbound.service';
import { buildChatDeliveryErrorMessage } from '../messages/chat-delivery.messages';
import { MetricsService } from '@messenger/modules/metrics/metrics.service';
import { trace, context, SpanStatusCode, SpanKind } from '@opentelemetry/api';

export interface EnqueueChatMessageInput {
  psid: string;
  userId?: number;
  userText: string;
  linkContext?: MessengerLinkContext;
  /** Meta message.mid — idempotency key for the last message in a debounce batch. */
  idempotencyKey?: string;
}

interface MemoryQueueContext {
  userId?: number;
  linkContext?: MessengerLinkContext;
}

interface ChatBatchInput {
  psid: string;
  mergedText: string;
  userId?: number;
  linkContext?: MessengerLinkContext;
  idempotencyKey?: string;
}

@Injectable()
export class MessengerChatQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(MessengerChatQueueService.name);
  private readonly debounceQueue: DebounceChatQueue<MemoryQueueContext>;
  private readonly sharedFlushTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  private static readonly DEFAULT_QUEUE_STALE_TTL_MS = 60 * 60 * 1000; // 1 hour
  private static readonly DEFAULT_QUEUE_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 min

  constructor(
    private readonly configService: ConfigService,
    private readonly outbound: MessengerOutboundService,
    private readonly messengerAgentService: MessengerAgentService,
    @Inject(CHAT_HISTORY_STORE)
    private readonly chatHistory: ChatHistoryStorePort,
    private readonly chatRateLimitService: ChatRateLimitService,
    private readonly metrics: MetricsService,
    @Inject(MESSENGER_REPOSITORY)
    private readonly messengerRepository: MessengerRepositoryPort,
    @Optional()
    private readonly sharedConfig?: MessengerChatSharedConfigService,
    @Optional()
    @Inject(CHAT_QUEUE_STORE)
    private readonly chatQueueStore?: ChatQueueStorePort,
  ) {
    this.debounceQueue = new DebounceChatQueue<MemoryQueueContext>(
      {
        getDebounceMs: () => this.getDebounceMs(),
        staleTtlMs:
          sharedConfig?.getQueueStaleTtlMs() ??
          MessengerChatQueueService.DEFAULT_QUEUE_STALE_TTL_MS,
        cleanupIntervalMs:
          sharedConfig?.getQueueCleanupIntervalMs() ??
          MessengerChatQueueService.DEFAULT_QUEUE_CLEANUP_INTERVAL_MS,
      },
      (batch) => this.handleMemoryFlush(batch),
    );
  }

  onModuleDestroy(): void {
    this.debounceQueue.destroy();

    for (const timer of this.sharedFlushTimers.values()) {
      clearTimeout(timer);
    }
    this.sharedFlushTimers.clear();
  }

  enqueue(input: EnqueueChatMessageInput): void {
    const text = input.userText.trim();
    if (!text) {
      return;
    }

    void this.outbound.sendSenderActionOptional(input.psid, 'mark_seen');

    if (this.isDistributedMode()) {
      void this.enqueueDistributed(input, text);
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

  /** H7: worker/cron entry for shared queue flush. */
  async flushReady(psid: string): Promise<void> {
    if (this.isDistributedMode()) {
      await this.flushDistributed(psid);
      return;
    }

    await this.debounceQueue.flushNow(psid);
  }

  private async enqueueDistributed(
    input: EnqueueChatMessageInput,
    text: string,
  ): Promise<void> {
    try {
      await this.chatQueueStore!.appendChatBuffer({
        psid: input.psid,
        userText: text,
        userId: input.userId,
        linkContext: input.linkContext,
        idempotencyKey: input.idempotencyKey,
        debounceMs: this.getDebounceMs(),
      });
      this.scheduleDistributedFlush(input.psid);
    } catch (error) {
      this.logger.error(
        `Distributed chat enqueue failed psid=${input.psid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private scheduleDistributedFlush(psid: string): void {
    const existing = this.sharedFlushTimers.get(psid);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.sharedFlushTimers.delete(psid);
      void this.flushDistributed(psid);
    }, this.getDebounceMs());
    timer.unref?.();

    this.sharedFlushTimers.set(psid, timer);
  }

  private async flushDistributed(psid: string): Promise<void> {
    const snapshot = await this.chatQueueStore!.claimReadyBuffer(
      psid,
      this.getDebounceMs(),
      this.sharedConfig!.getProcessingStuckMs(),
    );

    if (!snapshot || snapshot.texts.length === 0) {
      return;
    }

    const mergedText = capMergedChatUserText(
      mergeChatUserTexts(snapshot.texts),
      this.getMergedTextMaxChars(),
    );

    try {
      await this.processChatBatch({
        psid,
        mergedText,
        userId: snapshot.userId,
        linkContext: snapshot.linkContext,
        idempotencyKey: snapshot.lastIdempotencyKey,
      });
    } finally {
      const hasPending = await this.chatQueueStore!.completeChatBuffer({
        psid,
        debounceMs: this.getDebounceMs(),
      });

      if (hasPending) {
        this.scheduleDistributedFlush(psid);
      }
    }
  }

  private async handleMemoryFlush(
    batch: ChatQueueBatch<MemoryQueueContext>,
  ): Promise<void> {
    const mergedText = capMergedChatUserText(
      mergeChatUserTexts(batch.texts),
      this.getMergedTextMaxChars(),
    );

    await this.processChatBatch({
      psid: batch.externalUserId,
      mergedText,
      userId: batch.context?.userId,
      linkContext: batch.context?.linkContext,
      idempotencyKey: batch.idempotencyKey,
    });
  }

  private async processChatBatch(input: ChatBatchInput): Promise<void> {
    const tracer = trace.getTracer('messenger-ai-for-student');
    const rootSpan = tracer.startSpan('chat.batch', { kind: SpanKind.SERVER });
    rootSpan.setAttributes({
      'messenger.psid': input.psid,
      'messenger.idempotency_key': input.idempotencyKey ?? '',
      'messenger.user_id': input.userId ?? 0,
      'messenger.merged_text_len': input.mergedText.length,
    });

    await context.with(trace.setSpan(context.active(), rootSpan), async () => {
      try {
        await this.metrics.timeStep('chat_total', () =>
          this.processChatBatchInner(input),
        );
        rootSpan.setStatus({ code: SpanStatusCode.OK });
      } catch (err) {
        rootSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: String(err),
        });
        rootSpan.recordException(err as Error);
        throw err;
      } finally {
        rootSpan.end();
      }
    });
  }

  private async processChatBatchInner(input: ChatBatchInput): Promise<void> {
    const { psid, mergedText, userId, linkContext, idempotencyKey } = input;

    let reservedUsageDate: string | undefined;
    let reservedIdempotencyKey: string | undefined;
    let reservedQuota: ChatQuotaCheckResult | undefined;
    let mainReplyDelivered = false;
    let quotaFinalized = false;

    const finalizeQuota = async (): Promise<void> => {
      if (quotaFinalized || !reservedIdempotencyKey) {
        return;
      }

      await this.chatRateLimitService.markCompleted(reservedIdempotencyKey);
      quotaFinalized = true;
    };

    try {
      await this.outbound.sendSenderActionOptional(psid, 'typing_on');

      if (idempotencyKey) {
        const quota = await this.metrics.timeStep('rate_limit_reserve', () =>
          this.chatRateLimitService.reserveFreeFormSlot(psid, {
            userId,
            idempotencyKey,
          }),
        );

        if (!quota.allowed) {
          if (quota.reason === 'IDEMPOTENCY_CONFLICT') {
            this.logger.log(
              `Skipping duplicate chat flush mid=${idempotencyKey} psid=${psid}`,
            );
            return;
          }

          const denyReason =
            quota.reason === 'BURST_LIMIT' ? 'BURST_LIMIT' : 'DAILY_LIMIT';

          await this.outbound.sendTextViaPsid({
            psid,
            userId,
            text: buildChatQuotaDenyMessage(denyReason, quota.limit),
            messageType: 'CHAT_QUOTA_DENIED',
          });
          return;
        }

        if (quota.quotaReserved) {
          reservedUsageDate = quota.usageDate;
          reservedIdempotencyKey = idempotencyKey;
          reservedQuota = quota;

          await this.messengerRepository.logMessage({
            userId,
            psid,
            messageType: 'FREE_FORM_CHAT_IN',
            messageText: mergedText,
            status: 'SENT',
          });
        }
      } else if (this.chatRateLimitService.shouldEnforceForPsid(psid)) {
        this.logger.error(
          `Chat flush without message.mid psid=${psid}; skipped (H5)`,
        );
        return;
      } else {
        this.logger.warn(
          `Chat flush without message.mid psid=${psid}; rate limit reserve skipped`,
        );
      }

      const history = await this.metrics.timeStep('history_load', () =>
        this.chatHistory.getHistory(psid),
      );

      const reply = await this.metrics.timeStep('llm_agent', async () => {
        // Collect stream events into a final reply.
        // Future enhancement: on 'delta' events, send partial bubbles for
        // faster perceived response before all tool rounds complete.
        const stream = this.messengerAgentService.replyStream({
          psid,
          userId,
          userText: mergedText,
          linkContext,
          history,
          correlationId: idempotencyKey,
        });
        for await (const event of stream) {
          if (event.type === 'done') {
            return event.reply;
          }
          if (event.type === 'error') {
            throw event.error instanceof Error
              ? event.error
              : new Error(String(event.error));
          }
        }
        throw new Error('LLM agent stream ended without done event');
      });

      const assistantText = reply.text.trim();
      if (assistantText) {
        await this.metrics.timeStep('history_append', async () => {
          await this.chatHistory.appendTurn(psid, mergedText, assistantText);
          if (reply.toolSummary) {
            await this.chatHistory.appendToolSummary(psid, reply.toolSummary);
          }
        });
        mainReplyDelivered = await this.metrics.timeStep('meta_send', () =>
          this.deliverMainReplyBubbles({ psid, userId, text: assistantText }),
        );

        if (mainReplyDelivered) {
          await finalizeQuota();
        }
      } else if (reservedIdempotencyKey) {
        await finalizeQuota();
      }

      await this.deliverOptionalChatExtras({
        psid,
        userId,
        richFollowUps: reply.richFollowUps,
        reservedQuota,
      });
    } catch (error) {
      if (!quotaFinalized && !mainReplyDelivered) {
        if (reservedIdempotencyKey && reservedUsageDate) {
          await this.chatRateLimitService.refundFreeFormSlot(
            psid,
            reservedUsageDate,
            reservedIdempotencyKey,
          );
        }

        this.logger.error(
          `Chat queue failed before delivery psid=${psid}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        await this.sendChatDeliveryFallback(psid, userId, error, mergedText);
      } else {
        this.logger.error(
          `Chat queue failed after partial delivery psid=${psid}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private isDistributedMode(): boolean {
    return this.sharedConfig?.isDistributedQueueEnabled() === true;
  }

  /** H4: mark quota consumed once the first main reply bubble is sent. */
  private async deliverMainReplyBubbles(params: {
    psid: string;
    userId?: number;
    text: string;
  }): Promise<boolean> {
    const limits = readMessengerBubbleLimits(this.configService);
    try {
      const bubblesSent = await this.outbound.sendTextBubblesViaPsid({
        psid: params.psid,
        userId: params.userId,
        text: params.text,
        messageType: 'FREE_FORM_CHAT_OUT',
        maxBubbles: Math.min(limits.maxBubbles, 10),
        maxCharsPerBubble: Math.min(limits.maxCharsPerBubble, 2000),
      });

      return bubblesSent > 0;
    } catch (error) {
      if (error instanceof MessengerPartialSendError && error.bubblesSent > 0) {
        this.logger.warn(
          `Partial main reply delivery psid=${params.psid} bubblesSent=${error.bubblesSent}`,
        );
        return true;
      }

      throw error;
    }
  }

  /** H4: follow-up / hint failures must not rollback the main reply or quota. */
  private async deliverOptionalChatExtras(params: {
    psid: string;
    userId?: number;
    richFollowUps: Awaited<
      ReturnType<MessengerAgentService['reply']>
    >['richFollowUps'];
    reservedQuota?: ChatQuotaCheckResult;
  }): Promise<void> {
    if (params.richFollowUps.length > 0) {
      try {
        await this.outbound.sendRichFollowUps({
          psid: params.psid,
          userId: params.userId,
          followUps: params.richFollowUps,
        });
      } catch (error) {
        this.logger.warn(
          `Rich follow-up delivery failed psid=${params.psid}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (params.reservedQuota) {
      try {
        await this.sendQuotaRemainingHintIfNeeded(
          params.psid,
          params.userId,
          params.reservedQuota,
        );
      } catch (error) {
        this.logger.warn(
          `Quota hint delivery failed psid=${params.psid}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async sendChatDeliveryFallback(
    psid: string,
    userId: number | undefined,
    error: unknown,
    userText?: string,
  ): Promise<void> {
    try {
      await this.outbound.sendTextViaPsid({
        psid,
        userId,
        text: buildChatDeliveryErrorMessage(error, userText),
        messageType: 'FREE_FORM_CHAT_ERROR',
      });
    } catch (sendError) {
      this.logger.error(
        `Failed to send chat error fallback psid=${psid}: ${
          sendError instanceof Error ? sendError.message : String(sendError)
        }`,
      );
    }
  }

  private async sendQuotaRemainingHintIfNeeded(
    psid: string,
    userId: number | undefined,
    quota: ChatQuotaCheckResult,
  ): Promise<void> {
    const { remainingHintThreshold } = this.chatRateLimitService.getSettings();
    if (
      !shouldShowQuotaRemainingHint(quota.remaining, remainingHintThreshold)
    ) {
      return;
    }

    await this.outbound.sendTextViaPsid({
      psid,
      userId,
      text: buildChatQuotaRemainingHintMessage(quota.remaining),
      messageType: 'CHAT_QUOTA_REMAINING_HINT',
    });
  }

  private getMergedTextMaxChars(): number {
    return this.chatRateLimitService.getSettings().mergedTextMaxChars;
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
