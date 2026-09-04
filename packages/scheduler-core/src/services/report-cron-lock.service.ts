import { Injectable, Logger } from '@nestjs/common';
import {
  ADVISORY_LOCKS,
  PgAdvisoryLockService,
} from '@wispace/bot-common/locks';
import type { QueryRunner } from 'typeorm';
import type { Platform } from '@wispace/contracts';

/**
 * Per-platform daily-report cron advisory lock ids (#510) — each bot owns its
 * own id so the two 08:00 ICT crons cannot starve each other, while
 * concurrent pods within one platform still serialize (R4). Values are
 * registered in `ADVISORY_LOCKS` (bot-common).
 */
const REPORT_CRON_LOCK_IDS: Record<Platform, number> = {
  messenger: ADVISORY_LOCKS.MESSENGER_REPORT_CRON_DAILY,
  discord: ADVISORY_LOCKS.DISCORD_REPORT_CRON_DAILY,
  zalo: ADVISORY_LOCKS.ZALO_REPORT_CRON_DAILY,
};

@Injectable()
export class ReportCronLockService {
  private readonly logger = new Logger(ReportCronLockService.name);
  private runner: QueryRunner | null = null;

  constructor(
    private readonly pgLock: PgAdvisoryLockService,
    private readonly platform: Platform,
  ) {}

  async tryAcquireDailyLock(): Promise<boolean> {
    this.runner = await this.pgLock.acquire(
      REPORT_CRON_LOCK_IDS[this.platform],
    );
    if (!this.runner) {
      this.logger.log(
        `Report cron advisory lock not acquired for platform=${this.platform}; another pod is running the batch (R4)`,
      );
    }
    return this.runner !== null;
  }

  async releaseDailyLock(): Promise<void> {
    if (!this.runner) {
      return;
    }
    const runner = this.runner;
    this.runner = null;
    await this.pgLock.release(REPORT_CRON_LOCK_IDS[this.platform], runner);
  }
}
