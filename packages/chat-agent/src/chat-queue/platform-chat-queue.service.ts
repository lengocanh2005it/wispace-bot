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
  ChatPipelineResult,
  HistoryPort,
  OutboundPort,
  PipelineContext,
  RateLimiterPort,
} from '@wispace/chat-pipeline';
import { ChatPipeline } from '@wispace/chat-pipeline';
import {
  captureTraceContext,
  withExtractedTraceContext,
} from '@wispace/bot-common/tracing';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import { CHAT_FAILURE_FALLBACK_MESSAGE } from '@wispace/llm-agent/core';
import type { PlatformChatQueueOptions } from '../agent/platform-agent.types';
import { ChatRuntimeConfig } from '../chat-runtime-config';
import type { ChatQueueBufferSnapshot } from './chat-queue-store.types';
import type { ChatQueueStorePort } from './chat-queue-store.port';
import { readChatFlushRetrySettings } from './chat-queue-retry.config';

const REDIS_AVAILABILITY_WAIT_MS = 5_000;
const REDIS_AVAILABILITY_POLL_MS = 50;
const STALE_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

const PENDING_MESSAGE =
  'Đang xử lý tin nhắn trước, vui lòng chờ trong giây lát...';
const DROPPED_MESSAGE =
  'Bạn gửi hơi nhiều tin quá, mình chỉ xử lý được phần đầu thôi nhé';

// All module-level, not instance fields — deliberate but worth
// knowing before you reuse them. Messenger's equivalent gate is a per-instance
// `private readonly` Set (messenger-chat-processor.service.ts). These are safe
// as module state only because one process runs exactly one platform; two
// platforms sharing a process would collide on `externalUserId`.
//
// Entries are keyed per user and both `handleFlush` and its `finally` clear
// them, so a stale entry can never affect another learner.
/** Users who received a fallback in the current processing cycle. Prevents duplicate fallbacks on retry. Exported for testing. */
export const fallbackSentThisCycle = new Set<string>();

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
    sendText(
      externalUserId: string,
      text: string,
      options?: { userId?: number },
    ): Promise<void>;
  };

  constructor(
    configService: ConfigService,
    rateLimiter: RateLimiterPort,
    history: HistoryPort,
    agent: AgentPort,
    outbound: OutboundPort,
    directTextSender: {
      sendText(
        externalUserId: string,
        text: string,
        options?: { userId?: number },
      ): Promise<void>;
    },
    private readonly options: PlatformChatQueueOptions = {},
    private readonly queueStore?: ChatQueueStorePort,
    runtimeConfig?: ChatRuntimeConfig,
  ) {
    this.directTextSender = directTextSender;
    const runtime = runtimeConfig ?? new ChatRuntimeConfig(configService);
    this.distributed = runtime.queueMode() === 'redis';

    const nodeEnv =
      configService.get<string>('NODE_ENV')?.trim().toLowerCase() ??
      process.env.NODE_ENV?.trim().toLowerCase();
    if (nodeEnv === 'production' && !this.distributed) {
      throw new Error('CHAT_QUEUE_STORE=redis is required in production');
    }
    this.debounceMs = runtime.debounceMs;
    this.processingStuckMs = runtime.processingStuckMs;

    const retrySettings = readChatFlushRetrySettings(configService);
    this.retryEnabled = retrySettings.enabled;
    this.retryDelayMs = retrySettings.delayMs;

    const maxPendingSize =
      runtime.maxPendingSize === 0
        ? Number.MAX_SAFE_INTEGER
        : runtime.maxPendingSize;

    const hooks: ChatPipelineHooks = {
      onError: async (ctx: PipelineContext) => {
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
        if (ctx.reply?.clarification) {
          try {
            this.options.clarificationOutcomeInc?.('delivery_failure');
          } catch {
            // Telemetry must never change delivery/retry behavior.
          }
          // Re-open only the failed event's state; a generic fallback would
          // be a second user-visible reply for the same bounded flow.
          return;
        }
        try {
          // #406: Only send fallback once per processing cycle.
          if (!fallbackSentThisCycle.has(ctx.externalUserId)) {
            if (ctx.userId === undefined) {
              await directTextSender.sendText(
                ctx.externalUserId,
                CHAT_FAILURE_FALLBACK_MESSAGE,
              );
            } else {
              await directTextSender.sendText(
                ctx.externalUserId,
                CHAT_FAILURE_FALLBACK_MESSAGE,
                { userId: ctx.userId },
              );
            }
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
          onFlushTimedOut: (externalUserId, timeoutMs) => {
            this.logger.warn(
              `Chat queue flush stalled for ${maskExternalId(
                externalUserId,
              )} after ${timeoutMs}ms; releasing the queue for buffered messages (handler may finish later)`,
            );
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
      // The flush that eventually runs the LLM happens later — after the
      // debounce, and possibly on another pod. Carrying the trace context in
      // the buffer is what keeps the chat turn under the trace id the request
      // opened, instead of starting an unrelated one.
      const traceParent = captureTraceContext();
      await this.queueStore!.appendChatBuffer({
        externalUserId,
        userText,
        userId: ctx.userId,
        context:
          ctx.isServerChannel !== undefined || traceParent !== undefined
            ? {
                ...(ctx.isServerChannel !== undefined
                  ? { isServerChannel: ctx.isServerChannel }
                  : {}),
                ...(traceParent !== undefined ? { traceParent } : {}),
              }
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
        await this.sendDroppedNotice(externalUserId, batch.userId);
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

    try {
      const context = batch.context as
        | (QueueCtx & { traceParent?: string })
        | undefined;
      const sharedSnapshot = 'lastIdempotencyKey' in batch;
      const flush = () =>
        this.pipeline.flush({
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
      // `chat_total` is the platform's chat-availability SLO series (#371) —
      // timed only when the app wired the closure, ok/error recorded by the
      // metrics helper itself.
      // Re-establish the request's trace before the LLM span opens, so the
      // turn is a child of the request rather than a trace of its own.
      const result: ChatPipelineResult = await withExtractedTraceContext(
        context?.traceParent,
        () =>
          this.options.timeStep
            ? this.options.timeStep('chat_total', flush)
            : flush(),
      );

      switch (result.outcome) {
        case 'delivered':
        case 'denied':
        case 'duplicate':
          // Quota denial and duplicates are handled pipeline outcomes, not
          // delivery failures. Do not retry or leave the Redis lease in-flight.
          return 'completed';
        case 'failed': {
          if (result.reason === 'rate_limited') {
            return 'completed';
          }
          const fallbackWasSent = fallbackSentThisCycle.has(
            batch.externalUserId,
          );
          if (fallbackWasSent) {
            fallbackSentThisCycle.delete(batch.externalUserId);
            return 'completed';
          }
          return this.scheduleRetryForFailedBatch(batch);
        }
      }
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
        return 'completed';
      }

      fallbackSentThisCycle.delete(userId);
      return this.scheduleRetryForFailedBatch(batch);
    } finally {
      this.droppedNotified.delete(batch.externalUserId);
      fallbackSentThisCycle.delete(batch.externalUserId);
    }
  }

  private async sendDroppedNotice(
    externalUserId: string,
    userId?: number,
  ): Promise<void> {
    // The shared store owns the durable flag; delivery is best effort like the
    // old in-memory callback and the flag is cleared with the completed batch.
    await (
      userId === undefined
        ? this.directTextSender.sendText(externalUserId, DROPPED_MESSAGE)
        : this.directTextSender.sendText(externalUserId, DROPPED_MESSAGE, {
            userId,
          })
    ).catch(() => {});
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
