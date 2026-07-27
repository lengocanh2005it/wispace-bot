import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export const REPORT_CRON_ADVISORY_LOCK_ID = 8_842_008_01;

@Injectable()
export class ReportCronLockService {
  private readonly logger = new Logger(ReportCronLockService.name);
  private held = false;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async tryAcquireDailyLock(): Promise<boolean> {
    const rows: Array<{ acquired: boolean }> = await this.dataSource.query(
      `SELECT pg_try_advisory_lock($1::bigint) AS acquired`,
      [REPORT_CRON_ADVISORY_LOCK_ID],
    );

    const acquired = rows[0]?.acquired === true;
    this.held = acquired;

    if (!acquired) {
      this.logger.log(
        'Report cron advisory lock not acquired; another pod is running batch (R4)',
      );
    }

    return acquired;
  }

  async releaseDailyLock(): Promise<void> {
    if (!this.held) {
      return;
    }

    await this.dataSource.query(`SELECT pg_advisory_unlock($1::bigint)`, [
      REPORT_CRON_ADVISORY_LOCK_ID,
    ]);
    this.held = false;
  }
}
