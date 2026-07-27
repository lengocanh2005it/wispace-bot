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

    const repository = new ChatRateLimitRepository(
      dailyUsageRepo,
      idempotencyRepo,
      PLATFORM,
    );

    this.core = new ChatRateLimitCore(
      repository,
      new MemoryBurstCounter(),
      { freeFormDailyLimit, burstPerMinute, timezone },
      {
        warn: (msg) => this.logger.warn(msg),
        log: (msg) => this.logger.log(msg),
      },
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
}
