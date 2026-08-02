import { Injectable, Logger } from '@nestjs/common';
import { PgAdvisoryLockService } from '@wispace/bot-common';
import type { QueryRunner } from 'typeorm';

export const REPORT_CRON_ADVISORY_LOCK_ID = 8_842_008_01;

@Injectable()
export class ReportCronLockService {
  private readonly logger = new Logger(ReportCronLockService.name);
  private runner: QueryRunner | null = null;

  constructor(private readonly pgLock: PgAdvisoryLockService) {}

  async tryAcquireDailyLock(): Promise<boolean> {
    this.runner = await this.pgLock.acquire(REPORT_CRON_ADVISORY_LOCK_ID);
    if (!this.runner) {
      this.logger.log(
        'Report cron advisory lock not acquired; another pod is running batch (R4)',
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
    await this.pgLock.release(REPORT_CRON_ADVISORY_LOCK_ID, runner);
  }
}
