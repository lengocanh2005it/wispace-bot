import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DebounceChatQueue } from '@wispace/chat-queue-core';
import type { ChatQueueBatch } from '@wispace/chat-queue-core';
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

  private readonly mergedTextMaxChars: number;

  constructor(
    configService: ConfigService,
    private readonly rateLimitService: DiscordChatRateLimitService,
    private readonly historyService: DiscordChatHistoryService,
    private readonly outboundService: DiscordOutboundService,
    private readonly agentService: DiscordAgentService,
  ) {
    this.mergedTextMaxChars = Math.max(
      1,
      Number(configService.get<string>('CHAT_MERGED_TEXT_MAX_CHARS')) || 4000,
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
    const {
      externalUserId: discordUserId,
      texts,
      context,
      idempotencyKey,
    } = batch;
    const mergedText = texts.join('\n').slice(0, this.mergedTextMaxChars);

    const quota = idempotencyKey
      ? await this.rateLimitService.reserveFreeFormSlot(discordUserId, {
          idempotencyKey,
        })
      : null;
    if (quota && !quota.allowed) return;

    try {
      const reply = await this.agentService.reply({
        discordUserId,
        userId: context?.userId,
        userText: mergedText,
        correlationId: idempotencyKey,
        isServerChannel: context?.isServerChannel ?? false,
      });

      if (reply.text.trim()) {
        await this.historyService.appendTurn(
          discordUserId,
          mergedText,
          reply.text,
        );
        await this.outboundService.sendText(discordUserId, reply.text);
      }

      if (idempotencyKey)
        await this.rateLimitService.markCompleted(idempotencyKey);
    } catch (error) {
      if (idempotencyKey && quota?.usageDate) {
        await this.rateLimitService.refundFreeFormSlot(
          discordUserId,
          quota.usageDate,
          idempotencyKey,
        );
      }
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Chat queue flush failed for ${discordUserId}: ${msg}`);
    }
  }
}
