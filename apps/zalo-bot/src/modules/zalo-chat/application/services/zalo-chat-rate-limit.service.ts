import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  ChatRateLimitCore,
  ChatRateLimitRepository,
  MemoryBurstCounter,
} from '@wispace/chat-metering';

const PLATFORM = 'zalo';

@Injectable()
export class ZaloChatRateLimitService {
  private readonly logger = new Logger(ZaloChatRateLimitService.name);
  private readonly core: ChatRateLimitCore;
  private readonly enabled: boolean;

  constructor(
    @InjectRepository(ChatDailyUsageEntity)
    dailyUsageRepo: Repository<ChatDailyUsageEntity>,
    @InjectRepository(ChatIdempotencyEntity)
    idempotencyRepo: Repository<ChatIdempotencyEntity>,
    private readonly configService: ConfigService,
  ) {
    this.enabled =
      this.configService.get<string>('CHAT_RATE_LIMIT_ENABLED') === 'true';

    const freeFormDailyLimit = Number(
      this.configService.get<string>('CHAT_FREE_FORM_DAILY_LIMIT') ?? 15,
    );
    const burstPerMinute = Number(
      this.configService.get<string>('CHAT_BURST_PER_MINUTE') ?? 3,
    );
    const timezone =
      this.configService.get<string>('CHAT_USAGE_TIMEZONE') ??
      'Asia/Ho_Chi_Minh';
    const burstCountsRefunded =
      this.configService.get<string>('CHAT_BURST_COUNT_REFUNDED') === 'true';
    const stuckReservedMs = (() => {
      const raw = this.configService
        .get<string>('CHAT_IDEMPOTENCY_STUCK_RESERVED_MS')
        ?.trim();
      if (!raw) return 600_000;
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 ? value : 600_000;
    })();

    const repository = new ChatRateLimitRepository(
      dailyUsageRepo,
      idempotencyRepo,
      PLATFORM,
    );

    this.core = new ChatRateLimitCore(
      repository,
      new MemoryBurstCounter(),
      { freeFormDailyLimit, burstPerMinute, timezone, burstCountsRefunded },
      {
        warn: (msg) => this.logger.warn(msg),
        log: (msg) => this.logger.log(msg),
      },
      stuckReservedMs,
    );
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async reserve(zaloUserId: string, idempotencyKey: string) {
    return this.core.reserveFreeFormSlot(zaloUserId, { idempotencyKey });
  }

  async markCompleted(idempotencyKey: string) {
    return this.core.markCompleted(idempotencyKey);
  }

  async refund(zaloUserId: string, usageDate: string, idempotencyKey: string) {
    return this.core.refundFreeFormSlot(zaloUserId, usageDate, idempotencyKey);
  }

  async recoverStuckReservedSlots(): Promise<{ recovered: string[] }> {
    return this.core.recoverStuckReservedSlots();
  }
}
