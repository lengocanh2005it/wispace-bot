import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DebounceChatQueue } from '@wispace/chat-queue-core';
import type { ChatQueueBatch } from '@wispace/chat-queue-core';
import { ChatPipeline } from '@wispace/chat-pipeline';
import { DiscordRateLimiterAdapter } from '../../infrastructure/adapters/discord-chat-pipeline.adapters';
import { DiscordHistoryAdapter } from '../../infrastructure/adapters/discord-chat-pipeline.adapters';
import { DiscordAgentAdapter } from '../../infrastructure/adapters/discord-chat-pipeline.adapters';
import { DiscordOutboundAdapter } from '../../infrastructure/adapters/discord-chat-pipeline.adapters';
import { DiscordChatRateLimitService } from '../../../chat-metering/application/services/discord-chat-rate-limit.service';
import { DiscordChatHistoryService } from './discord-chat-history.service';
import { DiscordOutboundService } from './discord-outbound.service';
import { DiscordAgentService } from '../agent/discord-agent.service';

const DEFAULT_DEBOUNCE_MS = 2000;
const STALE_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

interface QueueCtx {
  userId?: number;
  isServerChannel: boolean;
}

@Injectable()
export class DiscordChatQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(DiscordChatQueueService.name);
  private readonly queue: DebounceChatQueue<QueueCtx>;
  private readonly pipeline: ChatPipeline;

  constructor(
    configService: ConfigService,
    rateLimitService: DiscordChatRateLimitService,
    historyService: DiscordChatHistoryService,
    outboundService: DiscordOutboundService,
    agentService: DiscordAgentService,
  ) {
    const mergedTextMaxChars = Math.max(
      1,
      Number(configService.get<string>('CHAT_MERGED_TEXT_MAX_CHARS')) || 4000,
    );

    this.pipeline = new ChatPipeline(
      new DiscordRateLimiterAdapter(rateLimitService),
      new DiscordHistoryAdapter(historyService),
      new DiscordAgentAdapter(agentService),
      new DiscordOutboundAdapter(outboundService),
      {},
      { mergedTextMaxChars },
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
    discordUserId: string,
    text: string,
    ctx: QueueCtx,
    idempotencyKey: string,
  ): void {
    this.queue.enqueue({
      externalUserId: discordUserId,
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
