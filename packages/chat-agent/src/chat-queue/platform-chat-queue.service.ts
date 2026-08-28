import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DebounceChatQueue } from '@wispace/chat-queue-core';
import type { ChatQueueBatch } from '@wispace/chat-queue-core';
import type {
  AgentPort,
  ChatPipelineHooks,
  HistoryPort,
  OutboundPort,
  PipelineContext,
  RateLimiterPort,
} from '@wispace/chat-pipeline';
import { ChatPipeline } from '@wispace/chat-pipeline';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import { CHAT_FAILURE_FALLBACK_MESSAGE } from '@wispace/llm-agent';
import type { PlatformChatQueueOptions } from '../agent/platform-agent.types';
import type { ChatQueueBufferSnapshot } from './chat-queue-store.types';
import type { ChatQueueStorePort } from './chat-queue-store.port';

const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_PROCESSING_STUCK_MS = 300_000;
const DEFAULT_FLUSH_RETRY_DELAY_MS = 5_000;
const REDIS_AVAILABILITY_WAIT_MS = 5_000;
const REDIS_AVAILABILITY_POLL_MS = 50;
const STALE_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

const PENDING_MESSAGE =
  'Đang xử lý tin nhắn trước, vui lòng chờ trong giây lát...';
const DROPPED_MESSAGE =
  'Bạn gửi hơi nhiều tin quá, mình chỉ xử lý được phần đầu thôi nhé';

/** Pending batch texts keyed by externalUserId — used by onError hook for #406 retry. */
const pendingBatchTexts = new Map<string, string[]>();
/** Users who received a fallback in the current processing cycle. Prevents duplicate fallbacks on retry. Exported for testing. */
export const fallbackSentThisCycle = new Set<string>();

interface QueueCtx {
  userId?: number;
  isServerChannel?: boolean;
}

/**
 * Debounces locally in development/tests and persists directly to Redis when
 * configured. The Redis worker is the only distributed flush path.
 */
@Injectable()
export class PlatformChatQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlatformChatQueueService.name);
  private readonly queue?: DebounceChatQueue<QueueCtx>;
  private readonly pipeline: ChatPipeline;
  private readonly distributed: boolean;
  private readonly debounceMs: number;
  private readonly processingStuckMs: number;
  private readonly droppedNotified = new Set<string>();
  private readonly retryEnabled: boolean;
  private readonly retryDelayMs: number;
  private readonly directTextSender: {
    sendText(externalUserId: string, text: string): Promise<void>;
  };

  constructor(
    configService: ConfigService,
    rateLimiter: RateLimiterPort,
    history: HistoryPort,
    agent: AgentPort,
    outbound: OutboundPort,
    directTextSender: {
      sendText(externalUserId: string, text: string): Promise<void>;
    },
    private readonly options: PlatformChatQueueOptions = {},
    private readonly queueStore?: ChatQueueStorePort,
  ) {
    this.directTextSender = directTextSender;
    const configuredStore =
      configService.get<string>('CHAT_QUEUE_STORE')?.trim().toLowerCase() ??
      (configService.get<string>('CHAT_QUEUE_SHARED')?.trim().toLowerCase() ===
      'true'
        ? 'redis'
        : 'memory');
    this.distributed = configuredStore === 'redis';

    const nodeEnv =
      configService.get<string>('NODE_ENV')?.trim().toLowerCase() ??
      process.env.NODE_ENV?.trim().toLowerCase();
    if (nodeEnv === 'production' && !this.distributed) {
      throw new Error('CHAT_QUEUE_STORE=redis is required in production');
    }
    this.debounceMs = Math.min(
      Math.max(
        Number(configService.get<string>('CHAT_DEBOUNCE_MS')) ||
          DEFAULT_DEBOUNCE_MS,
        0,
      ),
      10_000,
    );
    this.processingStuckMs = this.readPositiveNumber(
      configService.get<string>('CHAT_QUEUE_PROCESSING_STUCK_MS'),
      DEFAULT_PROCESSING_STUCK_MS,
    );

    this.retryEnabled =
      configService.get<string>('CHAT_FLUSH_RETRY_ENABLED')?.toLowerCase() ===
      'true';
    this.retryDelayMs = this.readPositiveNumber(
      configService.get<string>('CHAT_FLUSH_RETRY_DELAY_MS'),
      DEFAULT_FLUSH_RETRY_DELAY_MS,
    );

    const maxPendingSize =
      configService.get<string>('CHAT_MAX_PENDING_MESSAGES') === '0'
        ? Number.MAX_SAFE_INTEGER
        : Math.max(
            1,
            Number(configService.get<string>('CHAT_MAX_PENDING_MESSAGES')) ||
              20,
          );

    const hooks: ChatPipelineHooks = {
      onError: async (ctx: PipelineContext) => {
        const refundError = ctx.refundError
          ? ` refundError=${errorMessage(ctx.refundError)}`
          : '';
        this.logger.error(
          `chat_failure phase=original externalUserId=${maskExternalId(
            ctx.externalUserId,
          )} error=${errorMessage(ctx.error)}${refundError}`,
        );
        if (ctx.reply?.clarification) {
          try {
            this.options.clarificationOutcomeInc?.('delivery_failure');
          } catch {
            // Telemetry must never change delivery/retry behavior.
          }
          try {
            if (!ctx.deliveryAmbiguous) {
              await this.options.clarificationDeliveryFailure?.(
                ctx.externalUserId,
                ctx.idempotencyKey,
              );
            }
          } catch {
            // Recovery must never change delivery/retry behavior.
          }
          // Re-open only the failed event's state; a generic fallback would
          // be a second user-visible reply for the same bounded flow.
          return;
        }
        try {
          // #406: Only send fallback once per processing cycle.
          if (!fallbackSentThisCycle.has(ctx.externalUserId)) {
            await directTextSender.sendText(
              ctx.externalUserId,
              CHAT_FAILURE_FALLBACK_MESSAGE,
            );
            fallbackSentThisCycle.add(ctx.externalUserId);
          }
        } catch (fallbackError) {
          this.logger.error(
            `chat_failure phase=fallback_delivery externalUserId=${maskExternalId(
              ctx.externalUserId,
            )} error=${errorMessage(fallbackError)}`,
          );
        }
      },
    };

    if (options.typingIndicator !== undefined) {
      hooks.onStep = async (step: string, ctx: PipelineContext) => {
        if (step === 'before_agent') {
          await options.typingIndicator!(ctx.externalUserId).catch(() => {});
        }
      };
    }

    const pipelineConfig =
      options.mergedTextMaxChars !== undefined
        ? { mergedTextMaxChars: options.mergedTextMaxChars }
        : undefined;
    this.pipeline =
      pipelineConfig !== undefined
        ? new ChatPipeline(
            rateLimiter,
            history,
            agent,
            outbound,
            hooks,
            pipelineConfig,
          )
        : new ChatPipeline(rateLimiter, history, agent, outbound, hooks);

    if (!this.distributed) {
      this.queue = new DebounceChatQueue<QueueCtx>(
        {
          getDebounceMs: () => this.debounceMs,
          staleTtlMs: STALE_TTL_MS,
          cleanupIntervalMs: CLEANUP_INTERVAL_MS,
          maxPendingSize,
        },
        async (batch) => {
          await this.handleFlush(batch);
        },
        {
          onPendingQueued: (externalUserId, _text, pendingCount) => {
            if (pendingCount === 1) {
              directTextSender
                .sendText(externalUserId, PENDING_MESSAGE)
                .catch(() => {});
            }
          },
          onPendingDropped: (externalUserId, droppedCount) => {
            this.logger.warn(
              `Dropped ${droppedCount} pending message(s) for ${maskExternalId(
                externalUserId,
              )} (cap exceeded)`,
            );
            if (!this.droppedNotified.has(externalUserId)) {
              this.droppedNotified.add(externalUserId);
              directTextSender
                .sendText(externalUserId, DROPPED_MESSAGE)
                .catch(() => {});
            }
          },
          onShutdownRejected: (externalUserId) => {
            this.logger.warn(
              `Enqueue rejected during shutdown for ${maskExternalId(
                externalUserId,
              )} — queue is draining`,
            );
          },
        },
      );
    }
  }

  async onModuleInit(): Promise<void> {
    if (!this.distributed) {
      return;
    }
    if (!this.queueStore?.isAvailable()) {
      const deadline = Date.now() + REDIS_AVAILABILITY_WAIT_MS;
      while (Date.now() < deadline && !this.queueStore?.isAvailable()) {
        await new Promise((resolve) =>
          setTimeout(resolve, REDIS_AVAILABILITY_POLL_MS),
        );
      }
    }
    if (!this.queueStore?.isAvailable()) {
      throw new Error('Redis chat queue unavailable');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.destroy();
  }

  async enqueue(
    externalUserId: string,
    text: string,
    ctx: QueueCtx,
    idempotencyKey: string,
  ): Promise<void> {
    const userText = text.trim();
    if (this.distributed) {
      await this.queueStore!.appendChatBuffer({
        externalUserId,
        userText,
        userId: ctx.userId,
        context:
          ctx.isServerChannel !== undefined
            ? { isServerChannel: ctx.isServerChannel }
            : undefined,
        idempotencyKey,
        debounceMs: this.debounceMs,
      });
      return;
    }

    this.queue!.enqueue({
      externalUserId,
      text: userText,
      context: ctx,
      idempotencyKey,
    });
  }

  async flushReady(externalUserId: string): Promise<void> {
    if (!this.distributed) {
      return;
    }

    const batch = await this.queueStore!.claimReadyBuffer(
      externalUserId,
      this.debounceMs,
      this.processingStuckMs,
    );
    if (!batch) {
      return;
    }

    // #397: fresh-mapping revalidation — adopt the current WISPACE userId for
    // this platform identity before running the pipeline. If the mapping is
    // gone (user unlinked during debounce) the batch is dropped; if it changed
    // (user relinked) the fresh value replaces the stale snapshot.
    if (this.options.freshMappingProvider) {
      try {
        const freshUserId =
          await this.options.freshMappingProvider(externalUserId);
        if (freshUserId === undefined) {
          await this.clearClarificationState(externalUserId);
          this.logger.warn(
            `Dropping batch for ${maskExternalId(externalUserId)}: no active mapping (user may have unlinked)`,
          );
          // Batch was claimed — always complete it even when dropping.
          await this.queueStore!.completeChatBuffer({
            externalUserId,
            debounceMs: this.debounceMs,
          });
          return;
        }
        if (batch.userId !== undefined && batch.userId !== freshUserId) {
          await this.clearClarificationState(externalUserId);
          this.logger.warn(
            `Stale mapping for ${maskExternalId(externalUserId)}: buffered userId=${maskExternalId(String(batch.userId))} → fresh userId=${maskExternalId(String(freshUserId))}`,
          );
        }
        batch.userId = freshUserId;
      } catch (error) {
        // Transient infra failure — retry once, then fail-open.
        this.logger.error(
          `Fresh-mapping query failed for ${maskExternalId(externalUserId)}: ${errorMessage(error)}`,
        );
        try {
          const retryUserId =
            await this.options.freshMappingProvider!(externalUserId);
          if (retryUserId === undefined) {
            await this.clearClarificationState(externalUserId);
            this.logger.warn(
              `Dropping batch for ${maskExternalId(externalUserId)}: no active mapping after retry`,
            );
            await this.queueStore!.completeChatBuffer({
              externalUserId,
              debounceMs: this.debounceMs,
            });
            return;
          }
          if (batch.userId !== undefined && batch.userId !== retryUserId) {
            await this.clearClarificationState(externalUserId);
          }
          batch.userId = retryUserId;
        } catch (retryError) {
          this.logger.error(
            `Fresh-mapping retry failed for ${maskExternalId(externalUserId)}: ${errorMessage(retryError)} — proceeding with buffered userId`,
          );
        }
      }
    }

    let retryScheduled = false;
    try {
      if (batch.droppedNoticePending) {
        await this.sendDroppedNotice(externalUserId);
      }
      retryScheduled = await this.handleFlush(batch);
    } finally {
      this.droppedNotified.delete(externalUserId);
      if (!retryScheduled) {
        await this.queueStore!.completeChatBuffer({
          externalUserId,
          debounceMs: this.debounceMs,
        });
      }
    }
  }

  private async handleFlush(
    batch: ChatQueueBatch<QueueCtx> | ChatQueueBufferSnapshot,
  ): Promise<boolean> {
    // #406: Store batch texts for potential retry; clear fallback gate for this cycle.
    pendingBatchTexts.set(batch.externalUserId, [...batch.texts]);
    fallbackSentThisCycle.delete(batch.externalUserId);

    try {
      const context = batch.context as QueueCtx | undefined;
      const sharedSnapshot = 'lastIdempotencyKey' in batch;
      await this.pipeline.flush({
        externalUserId: batch.externalUserId,
        userId: sharedSnapshot ? batch.userId : context?.userId,
        texts: batch.texts,
        idempotencyKey: sharedSnapshot
          ? batch.lastIdempotencyKey
          : (batch as ChatQueueBatch<QueueCtx>).idempotencyKey,
        context:
          this.options.propagateServerChannel === true
            ? { isServerChannel: context?.isServerChannel === true }
            : undefined,
      });
      // Success: clean up all retry state.
      pendingBatchTexts.delete(batch.externalUserId);
      fallbackSentThisCycle.delete(batch.externalUserId);
    } catch (error) {
      const msg = errorMessage(error);
      this.logger.error(
        `Chat queue flush failed for ${maskExternalId(
          batch.externalUserId,
        )}: ${maskExternalIdInText(msg, batch.externalUserId)}`,
      );

      // #406: When pipeline fails, re-enqueue for bounded retry if enabled.
      // The onError hook sends a best-effort fallback message before this
      // catch block runs. If fallback was already sent, skip retry — the
      // user received a response. If fallback was NOT sent (or failed),
      // re-enqueue so the batch is not silently lost.
      const userId = batch.externalUserId;
      const fallbackWasSent = fallbackSentThisCycle.has(userId);

      let scheduled = false;
      if (this.retryEnabled && !fallbackWasSent && this.queueStore) {
        try {
          await this.queueStore.scheduleRetryFlush(userId, this.retryDelayMs);
          scheduled = true;
          this.logger.log(
            `Chat flush retry scheduled for ${maskExternalId(userId)} after ${this.retryDelayMs}ms`,
          );
        } catch (retryError) {
          this.logger.error(
            `Chat flush retry schedule failed for ${maskExternalId(userId)}: ${errorMessage(retryError)}`,
          );
        }
      } else if (this.retryEnabled && fallbackWasSent) {
        this.logger.log(
          `Chat flush retry skipped for ${maskExternalId(userId)}: fallback already delivered`,
        );
      }

      pendingBatchTexts.delete(userId);
      fallbackSentThisCycle.delete(userId);
      return scheduled;
    } finally {
      this.droppedNotified.delete(batch.externalUserId);
    }
    return false;
  }

  private async sendDroppedNotice(externalUserId: string): Promise<void> {
    // The shared store owns the durable flag; delivery is best effort like the
    // old in-memory callback and the flag is cleared with the completed batch.
    await this.directTextSender
      .sendText(externalUserId, DROPPED_MESSAGE)
      .catch(() => {});
  }

  private async clearClarificationState(externalUserId: string): Promise<void> {
    if (!this.options.clarificationStateClearer) return;
    try {
      await this.options.clarificationStateClearer(externalUserId);
    } catch (error) {
      this.logger.error(
        `Clarification state clear failed for ${maskExternalId(externalUserId)}: ${errorMessage(error)}`,
      );
    }
  }

  private readPositiveNumber(
    raw: string | undefined,
    fallback: number,
  ): number {
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }
}
