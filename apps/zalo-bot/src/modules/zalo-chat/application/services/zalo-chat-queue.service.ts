import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DebounceChatQueue } from '@wispace/chat-queue-core';
import type { ChatQueueBatch } from '@wispace/chat-queue-core';
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

  constructor(
    configService: ConfigService,
    private readonly rateLimitService: ZaloChatRateLimitService,
    private readonly historyService: ZaloChatHistoryService,
    private readonly outboundService: ZaloOutboundService,
    private readonly agentService: ZaloAgentService,
  ) {
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
    const {
      externalUserId: zaloUserId,
      texts,
      context,
      idempotencyKey,
    } = batch;
    const mergedText = texts.join('\n').slice(0, 4000);

    const quota = idempotencyKey
      ? await this.rateLimitService.reserve(zaloUserId, idempotencyKey)
      : null;
    if (quota && !quota.allowed) return;

    try {
      const reply = await this.agentService.reply({
        zaloUserId,
        userId: context?.userId,
        userText: mergedText,
        correlationId: idempotencyKey,
      });

      if (reply.text.trim()) {
        await this.historyService.appendTurn(
          zaloUserId,
          mergedText,
          reply.text,
        );
        await this.outboundService.sendText(zaloUserId, reply.text);
      }

      if (idempotencyKey)
        await this.rateLimitService.markCompleted(idempotencyKey);
    } catch (error) {
      if (idempotencyKey && quota?.usageDate) {
        await this.rateLimitService.refund(
          zaloUserId,
          quota.usageDate,
          idempotencyKey,
        );
      }
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Chat queue flush failed for ${zaloUserId}: ${msg}`);
    }
  }
}
