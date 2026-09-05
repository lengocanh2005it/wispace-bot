import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import { ADVISORY_LOCK } from '@messenger/shared/common/advisory-lock-ids';
import { ChatRateLimitService } from './chat-rate-limit.service';
import { BotMetricsService } from '@wispace/bot-metrics';

/**
 * H2 auto-recovery: finalize delivered slots and refund + release pre-delivery
 * quota slots stuck in `reserved` past `CHAT_IDEMPOTENCY_STUCK_RESERVED_MS`
 * (default 10 min). Runs every 5 minutes under an advisory lock — a crash
 * between reserve/delivery/finalization must not refund a delivered turn or
 * inflate `chat_daily_usage.free_form_count` forever.
 */
@Injectable()
export class ChatQuotaStuckRecoveryCronService {
  private readonly logger = new Logger(ChatQuotaStuckRecoveryCronService.name);

  constructor(
    private readonly chatRateLimitService: ChatRateLimitService,
    private readonly pgLock: PgAdvisoryLockService,
    @Optional() private readonly metrics?: BotMetricsService,
  ) {
    this.metrics?.registerCron?.('chat-quota-stuck-recovery', 5 * 60 * 1000);
  }

  @Cron('*/5 * * * *', {
    name: 'chat-quota-stuck-recovery',
  })
  async handleStuckRecovery(): Promise<void> {
    const result = await this.pgLock.withLock(
      ADVISORY_LOCK.CHAT_QUOTA_STUCK_RECOVERY,
      () => this.chatRateLimitService.recoverStuckReservedSlots(),
    );

    if (result === null) {
      this.logger.debug(
        'chat-quota-stuck-recovery skipped — lock held by another pod',
      );
      return;
    }

    this.metrics?.recordCronSuccess?.('chat-quota-stuck-recovery');

    if (result.recovered.length > 0) {
      this.logger.log(
        `chat-quota-stuck-recovery done: recovered=${result.recovered.length}`,
      );
    }
  }
}
