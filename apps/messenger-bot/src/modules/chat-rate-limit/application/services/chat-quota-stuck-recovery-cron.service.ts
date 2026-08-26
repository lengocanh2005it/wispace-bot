import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import { ADVISORY_LOCK } from '@messenger/shared/common/advisory-lock-ids';
import { ChatRateLimitService } from './chat-rate-limit.service';

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
  ) {}

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

    if (result.recovered.length > 0) {
      this.logger.log(
        `chat-quota-stuck-recovery done: recovered=${result.recovered.length}`,
      );
    }
  }
}
