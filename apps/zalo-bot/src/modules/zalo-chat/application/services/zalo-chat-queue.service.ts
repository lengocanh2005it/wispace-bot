import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DebounceChatQueue } from '@wispace/chat-queue-core';
import type { ChatQueueBatch } from '@wispace/chat-queue-core';
import { ChatPipeline } from '@wispace/chat-pipeline';
import {
  ZaloRateLimiterAdapter,
  ZaloHistoryAdapter,
  ZaloAgentAdapter,
  ZaloOutboundAdapter,
} from '../../infrastructure/adapters/zalo-chat-pipeline.adapters';
import { ZaloChatRateLimitService } from './zalo-chat-rate-limit.service';
import { ZaloChatHistoryService } from './zalo-chat-history.service';
import { ZaloOutboundService } from './zalo-outbound.service';
import { ZaloAgentService } from '../agent/zalo-agent.service';

const DEFAULT_DEBOUNCE_MS = 2000;
const STALE_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

interface QueueCtx {
  userId?: number;
}

@Injectable()
export class ZaloChatQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(ZaloChatQueueService.name);
  private readonly queue: DebounceChatQueue<QueueCtx>;
  private readonly pipeline: ChatPipeline;

  constructor(
    configService: ConfigService,
    rateLimitService: ZaloChatRateLimitService,
    historyService: ZaloChatHistoryService,
    outboundService: ZaloOutboundService,
    agentService: ZaloAgentService,
  ) {
    this.pipeline = new ChatPipeline(
      new ZaloRateLimiterAdapter(rateLimitService),
      new ZaloHistoryAdapter(historyService),
      new ZaloAgentAdapter(agentService),
      new ZaloOutboundAdapter(outboundService),
    );

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
      },
      (batch) => this.handleFlush(batch),
    );
  }

  onModuleDestroy(): void {
    this.queue.destroy();
  }

  enqueue(
    zaloUserId: string,
    text: string,
    ctx: QueueCtx,
    idempotencyKey: string,
  ): void {
    this.queue.enqueue({
      externalUserId: zaloUserId,
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
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Chat queue flush failed for ${batch.externalUserId}: ${msg}`,
      );
    }
  }
}
