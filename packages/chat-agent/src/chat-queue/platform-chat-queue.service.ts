import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
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
import { errorMessage, maskExternalId } from '@wispace/bot-common';
import { CHAT_FAILURE_FALLBACK_MESSAGE } from '@wispace/llm-agent';
import type { PlatformChatQueueOptions } from '../agent/platform-agent.types';

const DEFAULT_DEBOUNCE_MS = 2000;
const STALE_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

const PENDING_MESSAGE =
  'Đang xử lý tin nhắn trước, vui lòng chờ trong giây lát...';

interface QueueCtx {
  userId?: number;
  isServerChannel?: boolean;
}

/**
 * Debounce chat queue + flush pipeline shared by Discord and Zalo (replaces
 * their near-identical per-app queue services). Platform extras (merged-text
 * cap, typing indicator, server-channel context) are optional — Zalo uses
 * none, but both platforms get the same direct failure fallback.
 */
@Injectable()
export class PlatformChatQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(PlatformChatQueueService.name);
  private readonly queue: DebounceChatQueue<QueueCtx>;
  private readonly pipeline: ChatPipeline;

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
        try {
          await directTextSender.sendText(
            ctx.externalUserId,
            CHAT_FAILURE_FALLBACK_MESSAGE,
          );
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

    const config =
      options.mergedTextMaxChars !== undefined
        ? { mergedTextMaxChars: options.mergedTextMaxChars }
        : undefined;

    this.pipeline =
      config !== undefined
        ? new ChatPipeline(rateLimiter, history, agent, outbound, hooks, config)
        : new ChatPipeline(rateLimiter, history, agent, outbound, hooks);

    this.queue = new DebounceChatQueue<QueueCtx>(
      {
        getDebounceMs: () =>
          Math.min(
            Math.max(
              Number(configService.get<string>('CHAT_DEBOUNCE_MS')) ||
                DEFAULT_DEBOUNCE_MS,
              0,
            ),
            10_000,
          ),
        staleTtlMs: STALE_TTL_MS,
        cleanupIntervalMs: CLEANUP_INTERVAL_MS,
        maxPendingSize,
      },
      (batch) => this.handleFlush(batch),
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
        },
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.destroy();
  }

  enqueue(
    externalUserId: string,
    text: string,
    ctx: QueueCtx,
    idempotencyKey: string,
  ): void {
    this.queue.enqueue({
      externalUserId,
      text,
      context: ctx,
      idempotencyKey,
    });
  }

  private async handleFlush(batch: ChatQueueBatch<QueueCtx>): Promise<void> {
    try {
      await this.pipeline.flush({
        externalUserId: batch.externalUserId,
        userId: batch.context?.userId,
        texts: batch.texts,
        idempotencyKey: batch.idempotencyKey,
        context:
          this.options.propagateServerChannel === true
            ? {
                isServerChannel: batch.context?.isServerChannel === true,
              }
            : undefined,
      });
    } catch (error) {
      const msg = errorMessage(error);
      this.logger.error(
        `Chat queue flush failed for ${batch.externalUserId}: ${msg}`,
      );
    }
  }
}
