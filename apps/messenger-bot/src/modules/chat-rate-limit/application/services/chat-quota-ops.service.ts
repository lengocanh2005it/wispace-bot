import { Inject, Injectable } from '@nestjs/common';
import { todayUsageDate } from '@wispace/chat-metering';
import { subtractMs } from '@wispace/date-utils';
import { ChatQuotaOpsSummary } from '../../domain/entities/chat-quota-ops.types';
import { ChatRateLimitConfigService } from './chat-rate-limit-config.service';
import {
  CHAT_QUOTA_REPOSITORY,
  type ChatQuotaRepositoryPort,
} from '../../domain/repositories/chat-quota.repository.port';

@Injectable()
export class ChatQuotaOpsService {
  constructor(
    @Inject(CHAT_QUOTA_REPOSITORY)
    private readonly repository: ChatQuotaRepositoryPort,
    private readonly chatRateLimitConfigService: ChatRateLimitConfigService,
  ) {}

  async getSummary(): Promise<ChatQuotaOpsSummary> {
    const settings = this.chatRateLimitConfigService.getSettings();
    const stuckBefore = subtractMs(new Date(), settings.stuckReservedMs);
    const usageDate = todayUsageDate(settings.timezone);

    const [stuckReserved, idempotencyByStatus, usersAtDailyLimit] =
      await Promise.all([
        this.repository.countStuckReserved(stuckBefore),
        this.repository.countIdempotencyByStatusForUsageDate(usageDate),
        this.repository.countUsersAtOrAboveDailyLimit(
          usageDate,
          settings.freeFormDailyLimit,
        ),
      ]);

    return {
      usageDate,
      stuckReserved,
      stuckReservedMs: settings.stuckReservedMs,
      usersAtDailyLimit,
      dailyLimit: settings.freeFormDailyLimit,
      idempotencyByStatus,
      logGrepHints: [
        'CHAT_QUOTA_DENY',
        'CHAT_QUOTA_REFUND',
        'CHAT_QUOTA_RECOVERED',
      ],
    };
  }
}
