import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common';
import { ConfigService } from '@nestjs/config';
import { ChatRateLimitService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit.service';
import { ChatRateLimitConfigService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit-config.service';
import type { ChatQuotaCheckResult } from '@messenger/modules/chat-rate-limit/domain/entities/chat-quota.types';
import {
  buildChatQuotaDenyMessage,
  buildChatQuotaRemainingHintMessage,
} from '../messages/chat-quota.messages';
import { shouldShowQuotaRemainingHint } from '@messenger/modules/chat-rate-limit/domain/utils/quota-hint';
import { CHAT_HISTORY_STORE } from '../../domain/repositories/chat-history.store.port';
import type { ChatHistoryStorePort } from '../../domain/repositories/chat-history.store.port';
import { MESSENGER_MESSAGE_LOG_REPOSITORY } from '../../domain/repositories/messenger-message-log.repository.port';
import type { MessengerMessageLogRepositoryPort } from '../../domain/repositories/messenger-message-log.repository.port';
import { CHAT_QUEUE_STORE } from '../../domain/repositories/chat-queue.store.port';
import type { ChatQueueStorePort } from '../../domain/repositories/chat-queue.store.port';
import { MessengerAgentService } from '../agent/messenger-agent.service';
import {
  MessengerOutboundService,
  MessengerPartialSendError,
} from './messenger-outbound.service';
import { buildChatDeliveryErrorMessage } from '../messages/chat-delivery.messages';
import { buildChatDroppedMessage } from '../messages/chat-delivery.messages';
import { readMessengerBubbleLimits } from '../utils/messenger-bubble-config.utils';
import { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';
import { MetricsService } from '@messenger/modules/metrics/metrics.service';
import { trace, context, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import {
  capMergedChatUserText,
  mergeChatUserTexts,
} from '@messenger/shared/utils/messenger-text.utils';

export interface ChatBatchInput {
  psid: string;
  mergedText: string;
  userId?: number;
  linkContext?: MessengerLinkContext;
  idempotencyKey?: string;
}

@Injectable()
export class MessengerChatProcessorService {
  private readonly logger = new Logger(MessengerChatProcessorService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly outbound: MessengerOutboundService,
    private readonly messengerAgentService: MessengerAgentService,
    @Inject(CHAT_HISTORY_STORE)
    private readonly chatHistory: ChatHistoryStorePort,
    private readonly chatRateLimitService: ChatRateLimitService,
    private readonly chatRateLimitConfig: ChatRateLimitConfigService,
    private readonly metrics: MetricsService,
    @Inject(MESSENGER_MESSAGE_LOG_REPOSITORY)
    private readonly messengerRepository: MessengerMessageLogRepositoryPort,
    private readonly sharedConfig: MessengerChatSharedConfigService,
    @Inject(CHAT_QUEUE_STORE)
    private readonly chatQueueStore?: ChatQueueStorePort,
  ) {}

  /** H7: worker/cron entry for shared queue flush. */
  async flushReady(psid: string): Promise<void> {
    if (this.isDistributedMode()) {
      await this.flushDistributed(psid);
      return;
    }

    // Memory mode: flushNow is called from the EnqueueService's debounce queue.
    // This path should not be reached in memory mode, but handle gracefully.
    this.logger.warn(
      `flushReady called in memory mode for psid=${maskExternalId(
        psid,
      )}; ignoring`,
    );
  }

  /** Process a batch — called by EnqueueService after debounce/merge. */
  async process(input: ChatBatchInput): Promise<void> {
    await this.processChatBatch(input);
  }

  private async flushDistributed(psid: string): Promise<void> {
    const snapshot = await this.getChatQueueStore().claimReadyBuffer(
      psid,
      this.getDebounceMs(),
      this.sharedConfig.getProcessingStuckMs(),
    );

    if (!snapshot || snapshot.texts.length === 0) {
      return;
    }

    if (snapshot.droppedNoticePending) {
      await this.outbound
        .sendTextViaPsid({
          psid,
          text: buildChatDroppedMessage(),
          messageType: 'PENDING_FEEDBACK',
        })
        .catch((error) => {
          this.logger.error(
            `Failed to send drop notice to psid=${maskExternalId(
              psid,
            )}: ${errorMessage(error)}`,
          );
        });
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
      try {
        const hasPending = await this.getChatQueueStore().completeChatBuffer({
          psid,
          debounceMs: this.getDebounceMs(),
        });

        if (hasPending) {
          // Re-schedule via the EnqueueService's timer.
          // Import injected lazily to avoid circular dependency.
          // This is fine — the store write triggers the worker poll.
        }
      } catch (completeError) {
        this.logger.error(
          `completeChatBuffer failed psid=${maskExternalId(psid)}: ${errorMessage(
            completeError,
          )}`,
        );
      }
    }
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
              `Skipping duplicate chat flush mid=${idempotencyKey} psid=${maskExternalId(psid)}`,
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
      } else if (this.chatRateLimitConfig.shouldEnforceForPsid(psid)) {
        this.logger.error(
          `Chat flush without message.mid psid=${maskExternalId(
            psid,
          )}; skipped (H5)`,
        );
        return;
      } else {
        this.logger.warn(
          `Chat flush without message.mid psid=${maskExternalId(
            psid,
          )}; rate limit reserve skipped`,
        );
      }

      const history = await this.metrics.timeStep('history_load', () =>
        this.chatHistory.getHistory(psid),
      );

      const reply = await this.metrics.timeStep('llm_agent', async () =>
        this.messengerAgentService.reply({
          psid,
          userId,
          userText: mergedText,
          linkContext,
          history,
          correlationId: idempotencyKey,
        }),
      );

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
          `Chat queue failed before delivery psid=${maskExternalId(psid)}: ${errorMessage(
            error,
          )}`,
        );

        await this.sendChatDeliveryFallback(psid, userId, error, mergedText);
      } else {
        this.logger.error(
          `Chat queue failed after partial delivery psid=${maskExternalId(psid)}: ${errorMessage(
            error,
          )}`,
        );
      }
    }
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
          `Partial main reply delivery psid=${maskExternalId(
            params.psid,
          )} bubblesSent=${error.bubblesSent}`,
        );
        return true;
      }

      throw error;
    }
  }

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
          `Rich follow-up delivery failed psid=${maskExternalId(
            params.psid,
          )}: ${errorMessage(error)}`,
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
          `Quota hint delivery failed psid=${maskExternalId(
            params.psid,
          )}: ${errorMessage(error)}`,
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
        `Failed to send chat error fallback psid=${maskExternalId(psid)}: ${errorMessage(
          sendError,
        )}`,
      );
    }
  }

  private async sendQuotaRemainingHintIfNeeded(
    psid: string,
    userId: number | undefined,
    quota: ChatQuotaCheckResult,
  ): Promise<void> {
    const { remainingHintThreshold } = this.chatRateLimitConfig.getSettings();
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
