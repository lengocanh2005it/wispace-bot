import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  maskExternalId,
  errorMessage,
  sanitizeLogValue,
} from '@wispace/bot-common/masking';
import { TypeormRescheduleStore } from './typeorm-reschedule-store';
import {
  runLockedTick,
  type CronHeartbeatMetricsPort,
} from '@wispace/bot-common/cron';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import {
  applyNotificationOutcome,
  type RescheduleAttemptStorePort,
  type RescheduleNotificationOutcome,
} from '../reschedule-attempt.port';

const STALE_AFTER_MS = 5 * 60_000;
const MAX_NOTIFICATIONS_PER_TICK = 50;

export interface RescheduleRecoveryCronOptions {
  pgLock: PgAdvisoryLockService;
  lockId: number;
}

/**
 * Platform-specific transport for replaying a confirmation the learner never
 * received. Optional: a bot that has not wired it still recovers stale
 * requests, it just does not re-send confirmations.
 */
export interface RescheduleConfirmationNotificationPort {
  deliver(
    externalId: string,
    scheduledTimeLabel: string,
  ): Promise<RescheduleNotificationOutcome>;
  limit?: number;
}

/**
 * Recovers reschedule confirmations stranded by a pod crash, and replays
 * confirmations whose delivery was deferred.
 *
 * Runs every 5 minutes under one global advisory lock (#464) because the table
 * is shared by all three bots.
 *
 * #1418: a stale row is **not** blindly reset to pending. It is re-armed only
 * when no attempt record exists, which proves no calendar write was started. A
 * row whose attempt is still `attempting` has an unknown outcome — the write may
 * have committed and it is not idempotent — so it is cancelled (releasing the
 * learner) and escalated, never re-run.
 */
@Injectable()
export class RescheduleRecoveryCronService {
  private readonly logger = new Logger(RescheduleRecoveryCronService.name);

  constructor(
    @Inject(TypeormRescheduleStore)
    private readonly store: TypeormRescheduleStore<unknown>,
    private readonly metrics?: CronHeartbeatMetricsPort,
    private readonly lock?: RescheduleRecoveryCronOptions,
    @Optional()
    private readonly attemptStore?: RescheduleAttemptStorePort,
    @Optional()
    private readonly notification?: RescheduleConfirmationNotificationPort,
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
    const stale = await this.store.listStaleProcessing(STALE_AFTER_MS);

    let rearmed = 0;
    let escalated = 0;
    for (const row of stale) {
      const attempt = row.nonce
        ? await this.attemptStore
            ?.findAttempt(String(row.externalId), row.nonce)
            .catch(() => undefined)
        : undefined;

      if (attempt?.status === 'attempting') {
        await this.store.cancelStaleRow(row.id);
        escalated += 1;
        this.logger.error(
          `reschedule-recovery: ESCALATED unknown outcome for externalId=${maskExternalId(
            String(row.externalId),
          )} — calendar write may have committed; request cancelled and not re-run`,
        );
        continue;
      }
      if (attempt?.status === 'confirmed') {
        // The write already committed; only the staged row is stale.
        await this.store.cancelStaleRow(row.id);
        continue;
      }

      await this.store.revertStaleRow(row.id);
      rearmed += 1;
    }

    if (rearmed > 0 || escalated > 0) {
      this.logger.log(
        `reschedule-recovery: rearmed=${rearmed} escalated=${escalated}`,
      );
    }

    await this.replayDeferredConfirmations();
  }

  private async replayDeferredConfirmations(): Promise<void> {
    if (!this.notification || !this.attemptStore) {
      return;
    }
    const now = new Date();
    const due = await this.attemptStore.listDueNotificationAttempts(
      this.notification.limit ?? MAX_NOTIFICATIONS_PER_TICK,
      now,
    );
    for (const record of due) {
      try {
        const outcome = await this.notification.deliver(
          record.externalId,
          record.scheduledTimeLabel ?? '',
        );
        await applyNotificationOutcome(
          this.attemptStore,
          record.externalId,
          record.nonce,
          outcome,
          now,
        );
      } catch (error) {
        this.logger.warn(
          `reschedule-recovery: confirmation replay failed for externalId=${maskExternalId(
            record.externalId,
          )}: ${sanitizeLogValue(errorMessage(error), 300)}`,
        );
      }
    }
  }
}
