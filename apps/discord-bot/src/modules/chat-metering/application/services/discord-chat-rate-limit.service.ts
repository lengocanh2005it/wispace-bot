import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  ChatRateLimitCore,
  ChatRateLimitRepository,
  PostgresBurstCounter,
  type ChatQuotaCheckResult,
} from '@wispace/chat-metering';
import { ChatRateLimitConfigService } from './chat-rate-limit-config.service';

const PLATFORM = 'discord' as const;

/**
 * Thin NestJS adapter around the shared `@wispace/chat-metering` quota
 * engine — Discord counterpart to messenger-bot's `ChatRateLimitService`.
 * MVP: no whitelist, no quota-event audit table, no stuck-reserved
 * recovery cron (those stay Messenger-only ops tooling for now).
 */
@Injectable()
export class DiscordChatRateLimitService {
  private readonly logger = new Logger(DiscordChatRateLimitService.name);
  private core?: ChatRateLimitCore;

  constructor(
    private readonly configService: ChatRateLimitConfigService,
    @InjectRepository(ChatDailyUsageEntity)
    private readonly dailyUsageRepo: Repository<ChatDailyUsageEntity>,
    @InjectRepository(ChatIdempotencyEntity)
    private readonly idempotencyRepo: Repository<ChatIdempotencyEntity>,
  ) {}

  isEnabled(): boolean {
    return this.configService.isEnabled();
  }

  async reserveFreeFormSlot(
    discordUserId: string,
    params: { idempotencyKey: string },
  ): Promise<ChatQuotaCheckResult> {
    return this.getCore().reserveFreeFormSlot(discordUserId, params);
  }

  async refundFreeFormSlot(
    discordUserId: string,
    usageDate: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.getCore().refundFreeFormSlot(
      discordUserId,
      usageDate,
      idempotencyKey,
    );
  }

  async markCompleted(idempotencyKey: string): Promise<void> {
    await this.getCore().markCompleted(idempotencyKey);
  }

  async recoverStuckReservedSlots(): Promise<{ recovered: string[] }> {
    return this.getCore().recoverStuckReservedSlots();
  }

  private getCore(): ChatRateLimitCore {
    if (!this.core) {
      const repository = new ChatRateLimitRepository(
        this.dailyUsageRepo,
        this.idempotencyRepo,
        PLATFORM,
      );
      const settings = this.configService.getSettings();
      const stuckReservedMs = this.configService.getStuckReservedMs();
      this.core = new ChatRateLimitCore(
        repository,
        new PostgresBurstCounter(repository, settings.burstCountsRefunded),
        settings,
        { warn: (m) => this.logger.warn(m), log: (m) => this.logger.log(m) },
        stuckReservedMs,
      );
    }

    return this.core;
  }
}
