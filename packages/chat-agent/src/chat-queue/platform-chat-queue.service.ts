import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DebounceChatQueue } from '@wispace/chat-queue-core';
import type { ChatQueueBatch } from '@wispace/chat-queue-core';
import type {
  AgentPort,
  HistoryPort,
  OutboundPort,
  RateLimiterPort,
} from '@wispace/chat-pipeline';
import { ChatPipeline } from '@wispace/chat-pipeline';
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
 * none, so its pipeline gets exactly 4 constructor args like before.
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
    pendingTextSender: {
      sendText(externalUserId: string, text: string): Promise<void>;
    },
    private readonly options: PlatformChatQueueOptions = {},
  ) {
    const maxPendingSize = Math.max(
      1,
      Number(configService.get<string>('CHAT_MAX_PENDING_MESSAGES')) || 20,
    );

    const hooks =
      options.typingIndicator !== undefined
        ? {
            onStep: async (step: string, ctx: { externalUserId: string }) => {
              if (step === 'before_agent') {
                await options.typingIndicator!(ctx.externalUserId).catch(
                  () => {},
                );
              }
            },
          }
        : undefined;

    const config =
      options.mergedTextMaxChars !== undefined
        ? { mergedTextMaxChars: options.mergedTextMaxChars }
        : undefined;

    this.pipeline =
      hooks !== undefined && config !== undefined
        ? new ChatPipeline(rateLimiter, history, agent, outbound, hooks, config)
        : new ChatPipeline(rateLimiter, history, agent, outbound);

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
            pendingTextSender
              .sendText(externalUserId, PENDING_MESSAGE)
              .catch(() => {});
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

  onModuleDestroy(): void {
    this.queue.destroy();
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
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'unknown error';
      this.logger.error(
        `Chat queue flush failed for ${batch.externalUserId}: ${msg}`,
      );
    }
  }
}
