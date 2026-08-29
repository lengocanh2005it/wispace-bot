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
import {
  readChatFlushRetrySettings,
  readPositiveNumber,
} from './chat-queue-retry.config';

const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_PROCESSING_STUCK_MS = 300_000;
const REDIS_AVAILABILITY_WAIT_MS = 5_000;
const REDIS_AVAILABILITY_POLL_MS = 50;
const STALE_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

const PENDING_MESSAGE =
  'Đang xử lý tin nhắn trước, vui lòng chờ trong giây lát...';
const DROPPED_MESSAGE =
  'Bạn gửi hơi nhiều tin quá, mình chỉ xử lý được phần đầu thôi nhé';

/** Users who received a fallback in the current processing cycle. Prevents duplicate fallbacks on retry. Exported for testing. */
export const fallbackSentThisCycle = new Set<string>();
/** Distinguishes a delivery failure from a normal quota-denied false result. */
const failedFlushThisCycle = new Set<string>();

interface QueueCtx {
  userId?: number;
  isServerChannel?: boolean;
}

type FlushOutcome = 'completed' | 'retry_scheduled' | 'deferred';

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
    this.processingStuckMs = readPositiveNumber(
      configService.get<string>('CHAT_QUEUE_PROCESSING_STUCK_MS'),
      DEFAULT_PROCESSING_STUCK_MS,
    );

    const retrySettings = readChatFlushRetrySettings(configService);
    this.retryEnabled = retrySettings.enabled;
    this.retryDelayMs = retrySettings.delayMs;

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
        failedFlushThisCycle.add(ctx.externalUserId);
        const refundError = ctx.refundError
          ? ` refundError=${maskExternalIdInText(
              errorMessage(ctx.refundError),
              ctx.externalUserId,
            )}`
          : '';
        this.logger.error(
          `chat_failure phase=original externalUserId=${maskExternalId(
            ctx.externalUserId,
          )} error=${maskExternalIdInText(
            errorMessage(ctx.error),
            ctx.externalUserId,
          )}${refundError}`,
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
            )}: error=${maskExternalIdInText(
              errorMessage(fallbackError),
              ctx.externalUserId,
            )}`,
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

  async clear(externalUserId: string): Promise<void> {
    if (this.distributed) {
      await this.queueStore?.clearChatBuffer?.(externalUserId);
      return;
    }
    this.queue?.clear(externalUserId);
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
        const freshMapping = this.normalizeFreshMapping(
          await this.options.freshMappingProvider(externalUserId),
        );
        if (
          (await this.applyFreshMapping(batch, freshMapping)) !== 'continue'
        ) {
          return;
        }
      } catch (error) {
        // Retry once, then defer: a stale userId must never reach a personal
        // tool, and transient lookup failures must not destroy queued work.
        this.logger.error(
          `Fresh-mapping query failed for ${maskExternalId(
            externalUserId,
          )}: ${maskExternalIdInText(errorMessage(error), externalUserId)}`,
        );
        try {
          const retryMapping = this.normalizeFreshMapping(
            await this.options.freshMappingProvider!(externalUserId),
          );
          if (
            (await this.applyFreshMapping(batch, retryMapping)) !== 'continue'
          ) {
            return;
          }
        } catch (retryError) {
          this.logger.error(
            `Fresh-mapping retry failed for ${maskExternalId(
              externalUserId,
            )}: ${maskExternalIdInText(
              errorMessage(retryError),
              externalUserId,
            )} — deferring buffered batch`,
          );
          await this.deferFreshMappingBatch(batch);
          return;
        }
      }
    }

    let outcome: FlushOutcome = 'deferred';
    try {
      if (batch.droppedNoticePending) {
        await this.sendDroppedNotice(externalUserId);
      }
      outcome = await this.handleFlush(batch);
    } finally {
      this.droppedNotified.delete(externalUserId);
      if (outcome === 'completed') {
        await this.queueStore!.completeChatBuffer({
          externalUserId,
          debounceMs: this.debounceMs,
          leaseToken: batch.leaseToken,
        });
      }
    }
  }

  private async handleFlush(
    batch: ChatQueueBatch<QueueCtx> | ChatQueueBufferSnapshot,
  ): Promise<FlushOutcome> {
    // #406: clear the fallback gate for this processing cycle.
    fallbackSentThisCycle.delete(batch.externalUserId);
    failedFlushThisCycle.delete(batch.externalUserId);

    try {
      const context = batch.context as QueueCtx | undefined;
      const sharedSnapshot = 'lastIdempotencyKey' in batch;
      const delivered = await this.pipeline.flush({
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

      if (!delivered) {
        if (!failedFlushThisCycle.has(batch.externalUserId)) {
          // Quota denial is a handled pipeline outcome, not a delivery
          // failure. Do not retry or leave the Redis lease in-flight.
          return 'completed';
        }
        const fallbackWasSent = fallbackSentThisCycle.has(batch.externalUserId);
        if (fallbackWasSent) {
          fallbackSentThisCycle.delete(batch.externalUserId);
          failedFlushThisCycle.delete(batch.externalUserId);
          return 'completed';
        }
        return this.scheduleRetryForFailedBatch(batch);
      }

      // Success: clear the per-cycle fallback gate.
      fallbackSentThisCycle.delete(batch.externalUserId);
      return 'completed';
    } catch (error) {
      this.logger.error(
        `Chat queue flush failed for ${maskExternalId(
          batch.externalUserId,
        )}: ${maskExternalIdInText(errorMessage(error), batch.externalUserId)}`,
      );

      // #406: When pipeline fails, re-enqueue for bounded retry if enabled.
      // The onError hook sends a best-effort fallback message before this
      // catch block runs. If fallback was already sent, skip retry — the
      // user received a response. If fallback was NOT sent (or failed),
      // re-enqueue so the batch is not silently lost.
      const userId = batch.externalUserId;
      const fallbackWasSent = fallbackSentThisCycle.has(userId);
      if (fallbackWasSent) {
        fallbackSentThisCycle.delete(userId);
        failedFlushThisCycle.delete(userId);
        return 'completed';
      }

      fallbackSentThisCycle.delete(userId);
      failedFlushThisCycle.delete(userId);
      return this.scheduleRetryForFailedBatch(batch);
    } finally {
      this.droppedNotified.delete(batch.externalUserId);
      failedFlushThisCycle.delete(batch.externalUserId);
    }
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
        `Clarification state clear failed for ${maskExternalId(
          externalUserId,
        )}: ${maskExternalIdInText(errorMessage(error), externalUserId)}`,
      );
    }
  }

  private normalizeFreshMapping(
    result:
      | number
      | undefined
      | {
          state:
            | 'active'
            | 'temporarily-unknown'
            | 'confirmed-revoked'
            | 'locally-unlinked';
          userId?: number;
        },
  ): {
    state:
      | 'active'
      | 'temporarily-unknown'
      | 'confirmed-revoked'
      | 'locally-unlinked';
    userId?: number;
  } {
    if (typeof result === 'number') return { state: 'active', userId: result };
    if (result === undefined) return { state: 'locally-unlinked' };
    return result;
  }

  private async applyFreshMapping(
    batch: ChatQueueBufferSnapshot,
    mapping: {
      state:
        | 'active'
        | 'temporarily-unknown'
        | 'confirmed-revoked'
        | 'locally-unlinked';
      userId?: number;
    },
  ): Promise<'continue' | 'deferred' | 'dropped'> {
    if (mapping.state === 'temporarily-unknown') {
      await this.deferFreshMappingBatch(batch);
      return 'deferred';
    }

    if (mapping.state !== 'active' || mapping.userId === undefined) {
      await this.clearClarificationState(batch.externalUserId);
      this.logger.warn(
        `Dropping batch for ${maskExternalId(batch.externalUserId)}: no active mapping (state=${mapping.state})`,
      );
      await this.queueStore!.completeChatBuffer({
        externalUserId: batch.externalUserId,
        debounceMs: this.debounceMs,
        leaseToken: batch.leaseToken,
      });
      return 'dropped';
    }

    if (batch.userId !== undefined && batch.userId !== mapping.userId) {
      await this.clearClarificationState(batch.externalUserId);
      this.logger.warn(
        `Stale mapping for ${maskExternalId(batch.externalUserId)}: buffered userId=${maskExternalId(String(batch.userId))} → fresh userId=${maskExternalId(String(mapping.userId))}`,
      );
    }
    batch.userId = mapping.userId;
    return 'continue';
  }

  private async deferFreshMappingBatch(
    batch: ChatQueueBufferSnapshot,
  ): Promise<void> {
    const outcome = await this.scheduleRetryForFailedBatch(batch);
    if (outcome === 'deferred') {
      this.logger.warn(
        `Deferring queued batch for ${maskExternalId(batch.externalUserId)}: mapping status temporarily unknown`,
      );
    }
  }

  private async scheduleRetryForFailedBatch(
    batch: ChatQueueBatch<QueueCtx> | ChatQueueBufferSnapshot,
  ): Promise<FlushOutcome> {
    if (!this.retryEnabled || !this.queueStore || !('leaseToken' in batch)) {
      return 'deferred';
    }

    const userId = batch.externalUserId;
    try {
      const scheduled = await this.queueStore.scheduleRetryFlush(
        userId,
        this.retryDelayMs,
        batch.leaseToken,
      );
      if (scheduled) {
        this.logger.log(
          `Chat flush retry scheduled for ${maskExternalId(userId)} after ${this.retryDelayMs}ms`,
        );
        return 'retry_scheduled';
      }
    } catch (retryError) {
      this.logger.error(
        `Chat flush retry schedule failed for ${maskExternalId(
          userId,
        )}: ${maskExternalIdInText(errorMessage(retryError), userId)}`,
      );
    }
    return 'deferred';
  }
}
