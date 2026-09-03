import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import { ConfigService } from '@nestjs/config';
import { ChatPipeline } from '@wispace/chat-pipeline';
import type {
  PipelineContext,
  ChatPipelineHooks,
} from '@wispace/chat-pipeline';
import {
  detectPrivacyIntent,
  isConfirmationResponse,
  isCancellationResponse,
} from '@wispace/llm-agent';
import type { PrivacyIntent } from '@wispace/llm-agent';
import { ChatRateLimitService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit.service';
import { ChatRateLimitConfigService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit-config.service';
import {
  buildChatQuotaDenyMessage,
  buildChatQuotaRemainingHintMessage,
} from '../messages/chat-quota.messages';
import { shouldShowQuotaRemainingHint } from '@messenger/modules/chat-rate-limit/domain/utils/quota-hint';
import { MESSENGER_MESSAGE_LOG_REPOSITORY } from '../../domain/repositories/messenger-message-log.repository.port';
import type { MessengerMessageLogRepositoryPort } from '../../domain/repositories/messenger-message-log.repository.port';
import { CHAT_QUEUE_STORE } from '../../domain/repositories/chat-queue.store.port';
import type { ChatQueueStorePort } from '../../domain/repositories/chat-queue.store.port';
import { MESSENGER_REPOSITORY } from '../../domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '../../domain/repositories/messenger-mapping.repository.port';
import { MessengerAgentService } from '../agent/messenger-agent.service';
import { MessengerOutboundService } from './messenger-outbound.service';
import { buildChatDeliveryErrorMessage } from '../messages/chat-delivery.messages';
import { buildChatDroppedMessage } from '../messages/chat-delivery.messages';
import { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';
import { BotMetricsService } from '@wispace/bot-metrics';
import { trace, context, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import {
  capMergedChatUserText,
  mergeChatUserTexts,
} from '@messenger/shared/utils/messenger-text.utils';
import { PrivacyStateService } from '@wispace/llm-agent';
import { PrivacyDataService } from '@wispace/database';
import { createMessengerChatPipelineAdapters } from '../../infrastructure/adapters/messenger-chat-pipeline-adapters';
import {
  PlatformChatHistoryService,
  readChatFlushRetrySettings,
} from '@wispace/chat-agent';
import { RedisUserDisplayNameCache } from '@wispace/bot-common/redis';

export interface ChatBatchInput {
  psid: string;
  mergedText: string;
  userId?: number;
  linkContext?: MessengerLinkContext;
  idempotencyKey?: string;
}

/**
 * Messenger chat flush processor. Orchestrates the shared ChatPipeline
 * with Messenger-specific behavior:
 * - Pre-checks: quota deny messages, privacy intent intercept
 * - Pipeline: reserve → history → agent → send (bubbles) → mark → append → finalize
 * - Post-pipeline: rich follow-ups, quota hints
 * - Error: refund + fallback message
 *
 * Privacy intent lives in the processor (not agent service) because it needs
 * access to PrivacyStateService and PrivacyDataService which are Messenger-only.
 */
@Injectable()
export class MessengerChatProcessorService {
  private readonly logger = new Logger(MessengerChatProcessorService.name);
  private readonly pipeline: ChatPipeline;
  private queueClearer?: (psid: string) => Promise<void>;
  private readonly retryEnabled: boolean;
  private readonly retryDelayMs: number;
  private readonly fallbackSentThisCycle = new Set<string>();
  private readonly rateLimitedThisCycle = new Set<string>();

  constructor(
    private readonly outbound: MessengerOutboundService,
    private readonly messengerAgentService: MessengerAgentService,
    private readonly chatRateLimitService: ChatRateLimitService,
    private readonly chatRateLimitConfig: ChatRateLimitConfigService,
    private readonly metrics: BotMetricsService,
    @Inject(MESSENGER_MESSAGE_LOG_REPOSITORY)
    private readonly messengerRepository: MessengerMessageLogRepositoryPort,
    private readonly sharedConfig: MessengerChatSharedConfigService,
    private readonly historyService: PlatformChatHistoryService,
    private readonly configService: ConfigService,
    @Inject(CHAT_QUEUE_STORE)
    private readonly chatQueueStore?: ChatQueueStorePort,
    private readonly privacyState?: PrivacyStateService,
    private readonly privacyService?: PrivacyDataService,
    @Inject(MESSENGER_REPOSITORY)
    private readonly mappingRepository?: MessengerMappingRepositoryPort,
    private readonly displayNameCache?: RedisUserDisplayNameCache,
  ) {
    const retrySettings = readChatFlushRetrySettings(configService);
    this.retryEnabled = retrySettings.enabled;
    this.retryDelayMs = retrySettings.delayMs;

    const adapters = createMessengerChatPipelineAdapters(
      chatRateLimitService,
      historyService,
      messengerAgentService,
      outbound,
      configService,
    );

    const hooks: ChatPipelineHooks = {
      onStep: async (step: string, ctx: PipelineContext) => {
        if (step === 'before_agent') {
          await outbound
            .sendSenderActionOptional(ctx.externalUserId, 'typing_on')
            .catch(() => {});
        }
      },
      onError: async (ctx: PipelineContext) => {
        this.logger.error(
          `Chat pipeline failed psid=${maskExternalId(
            ctx.externalUserId,
          )}: ${maskExternalIdInText(
            errorMessage(ctx.error),
            ctx.externalUserId,
          )}`,
        );
        if (ctx.reply?.clarification) {
          try {
            this.metrics.incClarificationOutcome('delivery_failure');
          } catch {
            // Telemetry must never change delivery/retry behavior.
          }
          try {
            if (!ctx.deliveryAmbiguous) {
              await this.messengerAgentService.markClarificationDeliveryFailedForEvent(
                ctx.externalUserId,
                ctx.idempotencyKey,
              );
            }
          } catch {
            // Recovery must not change the durable inbox outcome.
          }
          // Re-open only the failed event's state; a generic fallback would
          // be a duplicate user-visible response for the same inbound event.
          return;
        }
        const userId = ctx.userId;
        try {
          if (!this.fallbackSentThisCycle.has(ctx.externalUserId)) {
            await outbound.sendTextViaPsid({
              psid: ctx.externalUserId,
              userId,
              text: buildChatDeliveryErrorMessage(ctx.error, ctx.mergedText),
              messageType: 'FREE_FORM_CHAT_ERROR',
            });
            this.fallbackSentThisCycle.add(ctx.externalUserId);
          }
        } catch (sendError) {
          this.logger.error(
            `Failed to send chat error fallback psid=${maskExternalId(
              ctx.externalUserId,
            )}: ${maskExternalIdInText(
              errorMessage(sendError),
              ctx.externalUserId,
            )}`,
          );
        }
      },
      onRateLimited: async (ctx: PipelineContext) => {
        this.rateLimitedThisCycle.add(ctx.externalUserId);
      },
      onAfterSend: async (ctx: PipelineContext) => {
        await this.deliverOptionalChatExtras({
          psid: ctx.externalUserId,
          userId: ctx.userId,
          richFollowUps: (ctx.reply?.richFollowUps ?? []) as Awaited<
            ReturnType<MessengerAgentService['reply']>
          >['richFollowUps'],
        });
      },
    };

    const pipelineConfig = {
      mergedTextMaxChars: chatRateLimitConfig.getSettings().mergedTextMaxChars,
    };

    this.pipeline = new ChatPipeline(
      adapters.rateLimiter,
      adapters.history,
      adapters.agent,
      adapters.outbound,
      hooks,
      pipelineConfig,
    );
  }

  /** Wired by the enqueue service so privacy erasure clears memory queues too. */
  setQueueClearer(clearer: (psid: string) => Promise<void>): void {
    this.queueClearer = clearer;
  }

  /** H7: worker/cron entry for shared queue flush. */
  async flushReady(psid: string): Promise<void> {
    if (this.isDistributedMode()) {
      await this.flushDistributed(psid);
      return;
    }

    this.logger.warn(
      `flushReady called in memory mode for psid=${maskExternalId(
        psid,
      )}; ignoring`,
    );
  }

  /** Process a batch — called by EnqueueService after debounce/merge. */
  async process(input: ChatBatchInput): Promise<boolean> {
    return this.processChatBatch(input);
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
          userId: snapshot.userId,
          text: buildChatDroppedMessage(),
          messageType: 'PENDING_FEEDBACK',
        })
        .catch((error) => {
          this.logger.error(
            `Failed to send drop notice to psid=${maskExternalId(
              psid,
            )}: ${maskExternalIdInText(errorMessage(error), psid)}`,
          );
        });
    }

    const mergedText = capMergedChatUserText(
      mergeChatUserTexts(snapshot.texts),
      this.getMergedTextMaxChars(),
    );

    let freshUserId = snapshot.userId;
    if (this.mappingRepository) {
      const freshMapping =
        await this.mappingRepository.findActiveMappingByPsid(psid);
      if (!freshMapping) {
        const state =
          await this.mappingRepository.findMappingStateByPsid?.(psid);
        if (state === 'temporarily-unknown') {
          await this.deferDistributedFlush(psid, snapshot.leaseToken);
          return;
        }
        await this.clearClarificationState(psid);
        this.logger.warn(
          `Dropping queued messages for psid=${maskExternalId(psid)}: no active mapping (state=${state ?? 'locally-unlinked'})`,
        );
        return;
      }
      if (
        snapshot.userId !== undefined &&
        snapshot.userId !== freshMapping.userId
      ) {
        await this.clearClarificationState(psid);
      }
      freshUserId = freshMapping.userId;
    }

    let retryScheduled = false;
    let shouldComplete = false;
    this.fallbackSentThisCycle.delete(psid);
    this.rateLimitedThisCycle.delete(psid);
    try {
      const delivered = await this.processChatBatch({
        psid,
        mergedText,
        userId: freshUserId,
        linkContext: snapshot.linkContext,
        idempotencyKey: snapshot.lastIdempotencyKey,
      });
      if (
        delivered ||
        this.fallbackSentThisCycle.has(psid) ||
        this.rateLimitedThisCycle.has(psid)
      ) {
        shouldComplete = true;
      } else if (this.retryEnabled) {
        try {
          retryScheduled = await this.getChatQueueStore().scheduleRetryFlush(
            psid,
            this.retryDelayMs,
            snapshot.leaseToken,
          );
          if (retryScheduled) {
            this.logger.log(
              `Chat flush retry scheduled for psid=${maskExternalId(psid)} after ${this.retryDelayMs}ms`,
            );
          }
        } catch (retryError) {
          this.logger.error(
            `Chat flush retry schedule failed for psid=${maskExternalId(
              psid,
            )}: ${maskExternalIdInText(errorMessage(retryError), psid)}`,
          );
        }
      }
    } catch (error) {
      const fallbackWasSent = this.fallbackSentThisCycle.has(psid);
      if (fallbackWasSent) {
        shouldComplete = true;
      } else if (this.retryEnabled) {
        try {
          retryScheduled = await this.getChatQueueStore().scheduleRetryFlush(
            psid,
            this.retryDelayMs,
            snapshot.leaseToken,
          );
          if (retryScheduled) {
            this.logger.log(
              `Chat flush retry scheduled for psid=${maskExternalId(psid)} after ${this.retryDelayMs}ms`,
            );
          }
        } catch (retryError) {
          this.logger.error(
            `Chat flush retry schedule failed for psid=${maskExternalId(
              psid,
            )}: ${maskExternalIdInText(errorMessage(retryError), psid)}`,
          );
        }
      }
      throw error;
    } finally {
      this.fallbackSentThisCycle.delete(psid);
      this.rateLimitedThisCycle.delete(psid);
      if (shouldComplete && !retryScheduled) {
        try {
          await this.getChatQueueStore().completeChatBuffer({
            psid,
            debounceMs: this.getDebounceMs(),
            leaseToken: snapshot.leaseToken,
          });
        } catch (completeError) {
          this.logger.error(
            `completeChatBuffer failed psid=${maskExternalId(
              psid,
            )}: ${maskExternalIdInText(errorMessage(completeError), psid)}`,
          );
        }
      }
    }
  }

  private async processChatBatch(input: ChatBatchInput): Promise<boolean> {
    const tracer = trace.getTracer('messenger-ai-for-student');
    const rootSpan = tracer.startSpan('chat.batch', { kind: SpanKind.SERVER });
    rootSpan.setAttributes({
      'messenger.psid': input.psid,
      'messenger.idempotency_key': input.idempotencyKey ?? '',
      'messenger.user_id': input.userId ?? 0,
      'messenger.merged_text_len': input.mergedText.length,
    });

    return context.with(trace.setSpan(context.active(), rootSpan), async () => {
      try {
        const delivered = await this.metrics.timeStep('chat_total', () =>
          this.processChatBatchInner(input),
        );
        rootSpan.setStatus({
          code: delivered ? SpanStatusCode.OK : SpanStatusCode.ERROR,
          ...(delivered ? {} : { message: 'delivery not confirmed' }),
        });
        return delivered;
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

  private async processChatBatchInner(input: ChatBatchInput): Promise<boolean> {
    const { psid, mergedText, idempotencyKey } = input;
    let { userId, linkContext } = input;
    let reservedUsageDate: string | undefined;

    // #383: revalidate linkContext against the fresh mapping — if the mapping
    // was updated (relinked/unlinked) during the debounce window, a stale
    // context could disagree with the active identity.
    if (linkContext && this.mappingRepository) {
      const freshMapping =
        await this.mappingRepository.findActiveMappingByPsid(psid);
      if (!freshMapping) {
        await this.clearClarificationState(psid);
        this.logger.warn(
          `Dropping batch for psid=${maskExternalId(psid)}: no active mapping after revalidation`,
        );
        return true;
      }
      if (freshMapping.userId !== linkContext.userId) {
        await this.clearClarificationState(psid);
        this.logger.warn(
          `Discarding stale linkContext for psid=${maskExternalId(psid)}: context userId=${maskExternalId(String(linkContext.userId))} vs mapping userId=${maskExternalId(String(freshMapping.userId))}`,
        );
        linkContext = undefined;
        userId = freshMapping.userId;
      }
    }

    // ── Pre-pipeline checks ──────────────────────────────────────────

    // Privacy intercept — runs before the quota block so a bare "Có"/"Không"
    // reply (or a keyword request) never reserves a free-form slot or reaches
    // the LLM. While a privacy action is pending, EVERY message routes to the
    // privacy handler until the user confirms/cancels or the pending TTL
    // expires (#660).
    if (this.privacyState && this.privacyService) {
      const pendingAction = this.privacyState.getPendingAction(
        psid,
        'messenger',
      );
      const privacyIntent = detectPrivacyIntent(mergedText);
      if (pendingAction || privacyIntent) {
        await this.handlePrivacyIntent(
          psid,
          userId,
          mergedText,
          privacyIntent,
          pendingAction,
        );
        return true;
      }
    }

    // Quota pre-check + deny messages (processor wrapper, not pipeline)
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
          return true;
        }

        const denyReason =
          quota.reason === 'BURST_LIMIT' ? 'BURST_LIMIT' : 'DAILY_LIMIT';

        await this.outbound.sendTextViaPsid({
          psid,
          userId,
          text: buildChatQuotaDenyMessage(denyReason, quota.limit),
          messageType: 'CHAT_QUOTA_DENIED',
        });
        return true;
      }

      if (quota.quotaReserved) {
        reservedUsageDate = quota.usageDate;
        await this.messengerRepository.logMessage({
          userId,
          psid,
          messageType: 'FREE_FORM_CHAT_IN',
          status: 'SENT',
        });
      }
    } else if (this.chatRateLimitConfig.shouldEnforceForPsid(psid)) {
      this.logger.error(
        `Chat flush without message.mid psid=${maskExternalId(
          psid,
        )}; skipped (H5)`,
      );
      return true;
    } else {
      this.logger.warn(
        `Chat flush without message.mid psid=${maskExternalId(
          psid,
        )}; rate limit reserve skipped`,
      );
    }

    // ── Pipeline flush ───────────────────────────────────────────────

    return this.metrics.timeStep('pipeline_flush', () =>
      this.pipeline.flush({
        externalUserId: psid,
        userId,
        texts: [mergedText],
        idempotencyKey,
        reservedUsageDate,
        context: linkContext ? { linkContext } : undefined,
      }),
    );
  }

  private async handlePrivacyIntent(
    psid: string,
    userId: number | undefined,
    mergedText: string,
    privacyIntent: PrivacyIntent,
    pendingAction: PrivacyIntent,
  ): Promise<void> {
    if (!pendingAction) {
      // Caller only routes here when pendingAction || privacyIntent, so this
      // branch always has a fresh intent.
      if (!privacyIntent) return;
      const confirmMessage = this.privacyState!.setPendingAction(
        psid,
        'messenger',
        privacyIntent,
      );
      await this.outbound.sendTextViaPsid({
        psid,
        userId,
        text: confirmMessage,
        messageType: 'PRIVACY_CONFIRM',
      });
      return;
    }

    if (isConfirmationResponse(mergedText)) {
      // Durable record of the consent before the irreversible action runs.
      await this.logPrivacyInbound(psid, userId, 'PRIVACY_CONFIRM_IN');
      // ponytail: pending is cleared before execute; in distributed mode a
      // retry after an execute failure loses the request (out of scope — #461).
      this.privacyState!.clearPendingAction(psid, 'messenger');

      let resultMessage: string;
      switch (pendingAction) {
        case 'unlink': {
          const result = await this.privacyService!.unlink('messenger', psid, {
            clearHistory: (id) => this.historyService.clear(id),
            clearQueuedWork: (id) => this.clearQueuedWork(id),
            clearClarification: (id) => this.clearClarificationState(id),
            clearUserCache: (userId) =>
              this.displayNameCache?.del(userId) ?? Promise.resolve(),
          });
          resultMessage = result.deleted
            ? 'Đã ngắt kết nối tài khoản thành công.'
            : 'Tài khoản chưa được liên kết.';
          break;
        }
        case 'delete': {
          await this.privacyService!.delete('messenger', psid, {
            clearHistory: (id) => this.historyService.clear(id),
            clearQueuedWork: (id) => this.clearQueuedWork(id),
            clearClarification: (id) => this.clearClarificationState(id),
            clearUserCache: (userId) =>
              this.displayNameCache?.del(userId) ?? Promise.resolve(),
          });
          resultMessage = 'Đã xóa toàn bộ dữ liệu thành công.';
          break;
        }
        case 'export': {
          const data = await this.privacyService!.export('messenger', psid);
          resultMessage = `Dữ liệu của bạn:\n${JSON.stringify(data, null, 2)}`;
          break;
        }
        default:
          resultMessage = 'Thao tác không được hỗ trợ.';
      }

      await this.outbound.sendTextViaPsid({
        psid,
        userId,
        text: resultMessage,
        messageType: 'PRIVACY_RESULT',
      });
      return;
    }

    if (isCancellationResponse(mergedText)) {
      await this.logPrivacyInbound(psid, userId, 'PRIVACY_CANCEL_IN');
      this.privacyState!.clearPendingAction(psid, 'messenger');
      await this.outbound.sendTextViaPsid({
        psid,
        userId,
        text: 'Đã hủy thao tác.',
        messageType: 'PRIVACY_CANCELLED',
      });
      return;
    }

    await this.outbound.sendTextViaPsid({
      psid,
      userId,
      text: 'Reply "Có" để xác nhận hoặc "Không" để hủy.',
      messageType: 'PRIVACY_REMIND',
    });
  }

  /** Audit trail for an in-chat privacy consent/cancellation (compliance). */
  private async logPrivacyInbound(
    psid: string,
    userId: number | undefined,
    messageType: 'PRIVACY_CONFIRM_IN' | 'PRIVACY_CANCEL_IN',
  ): Promise<void> {
    try {
      await this.messengerRepository.logMessage({
        userId,
        psid,
        messageType,
        status: 'SENT',
      });
    } catch (error) {
      this.logger.warn(
        `Privacy inbound log failed psid=${maskExternalId(
          psid,
        )}: ${maskExternalIdInText(errorMessage(error), psid)}`,
      );
    }
  }

  private clearQueuedWork(psid: string): Promise<void> {
    if (this.queueClearer) return this.queueClearer(psid);
    return (
      this.chatQueueStore?.clearChatBuffer?.(psid).then(() => undefined) ??
      Promise.resolve()
    );
  }

  private async clearClarificationState(psid: string): Promise<void> {
    const clearer = (
      this.messengerAgentService as MessengerAgentService & {
        clearClarificationState?: (externalUserId: string) => Promise<void>;
      }
    ).clearClarificationState;
    if (!clearer) return;
    try {
      await clearer.call(this.messengerAgentService, psid);
    } catch (error) {
      this.logger.warn(
        `Clarification state clear failed psid=${maskExternalId(
          psid,
        )}: ${maskExternalIdInText(errorMessage(error), psid)}`,
      );
    }
  }

  private async deliverOptionalChatExtras(params: {
    psid: string;
    userId?: number;
    richFollowUps: Awaited<
      ReturnType<MessengerAgentService['reply']>
    >['richFollowUps'];
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
          )}: ${maskExternalIdInText(errorMessage(error), params.psid)}`,
        );
      }
    }

    // Quota remaining hint — query current usage after delivery
    try {
      const { remainingHintThreshold } = this.chatRateLimitConfig.getSettings();
      const quota = await this.chatRateLimitService.getRemainingQuota(
        params.psid,
      );
      if (
        shouldShowQuotaRemainingHint(quota.remaining, remainingHintThreshold)
      ) {
        await this.outbound.sendTextViaPsid({
          psid: params.psid,
          userId: params.userId,
          text: buildChatQuotaRemainingHintMessage(quota.remaining),
          messageType: 'CHAT_QUOTA_REMAINING_HINT',
        });
      }
    } catch (error) {
      this.logger.warn(
        `Quota hint delivery failed psid=${maskExternalId(
          params.psid,
        )}: ${maskExternalIdInText(errorMessage(error), params.psid)}`,
      );
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

  private async deferDistributedFlush(
    psid: string,
    leaseToken: string,
  ): Promise<void> {
    if (!this.retryEnabled) return;
    try {
      const scheduled = await this.getChatQueueStore().scheduleRetryFlush(
        psid,
        this.retryDelayMs,
        leaseToken,
      );
      if (scheduled) {
        this.logger.log(
          `Deferred queued Messenger batch for psid=${maskExternalId(psid)} after mapping status became temporarily unknown`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Messenger unknown mapping retry scheduling failed psid=${maskExternalId(psid)}: ${maskExternalIdInText(errorMessage(error), psid)}`,
      );
    }
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
