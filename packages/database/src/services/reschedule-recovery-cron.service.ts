import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TypeormRescheduleStore } from './typeorm-reschedule-store';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import { runLockedTick } from '@wispace/bot-common/cron';
import type { CronHeartbeatMetricsPort } from './platform-dead-letter-cron.service';

const STALE_AFTER_MS = 5 * 60_000;

export interface RescheduleRecoveryCronOptions {
  pgLock: PgAdvisoryLockService;
  lockId: number;
}

/**
 * Recovers reschedule confirmations stuck in 'processing' after a pod crash.
 * Runs every 5 minutes; resets expired rows back to 'pending' with a fresh TTL.
 *
 * The same global table is shared by all three bots, so a single advisory
 * lock (#464) serializes the tick across every pod — without it two workers
 * could reset the same stale rows (or a live confirmation) concurrently.
 * Pass `options` (pgLock + lockId) from the app module factories; omitting
 * it preserves the legacy unlocked behavior.
 */
@Injectable()
export class RescheduleRecoveryCronService {
  private readonly logger = new Logger(RescheduleRecoveryCronService.name);

  constructor(
    @Inject(TypeormRescheduleStore)
    private readonly store: TypeormRescheduleStore<unknown>,
    private readonly metrics?: CronHeartbeatMetricsPort,
    private readonly lock?: RescheduleRecoveryCronOptions,
  ) {
    this.metrics?.registerCron('reschedule-recovery', 5 * 60 * 1000);
  }

  @Cron('*/5 * * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleRecovery(): Promise<void> {
    if (!this.lock) {
      await this.runRecovery();
      this.metrics?.recordCronSuccess('reschedule-recovery');
      return;
    }

    await runLockedTick({
      name: 'reschedule-recovery',
      withLock: (run) => this.lock!.pgLock.withLock(this.lock!.lockId, run),
      run: async () => {
        await this.runRecovery();
        return [{ outcome: 'succeeded' as const }];
      },
      metrics: this.metrics,
      logger: this.logger,
    });
  }

  private async runRecovery(): Promise<void> {
    const recovered = await this.store.recoverStaleProcessing(STALE_AFTER_MS);

    if (recovered > 0) {
      this.logger.log(
        `reschedule-recovery: reset ${recovered} stale processing row(s) to pending`,
      );
    }
  }
}
