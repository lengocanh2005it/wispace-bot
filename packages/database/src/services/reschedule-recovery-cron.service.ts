import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TypeormRescheduleStore } from './typeorm-reschedule-store';

const STALE_AFTER_MS = 5 * 60_000;

/**
 * Recovers reschedule confirmations stuck in 'processing' after a pod crash.
 * Runs every 5 minutes; resets expired rows back to 'pending' with a fresh TTL.
 */
@Injectable()
export class RescheduleRecoveryCronService {
  private readonly logger = new Logger(RescheduleRecoveryCronService.name);
  private readonly owner: string;

  constructor(
    @Inject(TypeormRescheduleStore)
    private readonly store: TypeormRescheduleStore<unknown>,
  ) {
    this.owner = process.env.HOSTNAME?.trim() || 'unknown';
  }

  @Cron('*/5 * * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleRecovery(): Promise<void> {
    const recovered = await this.store.recoverStaleProcessing(
      this.owner,
      STALE_AFTER_MS,
    );

    if (recovered > 0) {
      this.logger.log(
        `reschedule-recovery: reset ${recovered} stale processing row(s) to pending`,
      );
    }
  }
}
