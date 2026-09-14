import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { DataSource } from 'typeorm';
import type { Platform } from '@wispace/contracts';
import { CleanupCronService } from './cleanup-cron.service';

const CRON_EXPRESSION = '0 15 4 * * *';

export interface PlatformLinkAuditCleanupOptions {
  platform: Platform;
  advisoryLockId: number;
}

/** Retains redacted ownership-transition audit rows for a bounded period. */
@Injectable()
export class PlatformLinkAuditCleanupService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PlatformLinkAuditCleanupService.name);
  private readonly jobName: string;
  private readonly options: PlatformLinkAuditCleanupOptions;
  private job?: CronJob;

  constructor(
    private readonly cleanupCron: CleanupCronService,
    @InjectDataSource() private readonly dataSource: DataSource,
    options: PlatformLinkAuditCleanupOptions,
  ) {
    this.options = options;
    this.jobName = `${options.platform}-platform-link-audit-cleanup`;
  }

  onModuleInit(): void {
    this.job = CronJob.from({
      cronTime: CRON_EXPRESSION,
      timeZone: 'Asia/Ho_Chi_Minh',
      onTick: () => {
        void this.handleDailyCleanup().catch((error) =>
          this.logger.error(`${this.jobName} failed`, error),
        );
      },
      start: true,
    });
  }

  onModuleDestroy(): void {
    void this.job?.stop();
    this.job = undefined;
  }

  async handleDailyCleanup(): Promise<void> {
    await this.cleanupCron.execute(
      this.jobName,
      this.options.advisoryLockId,
      (cutoff) => this.deleteBatched(cutoff!),
    );
  }

  private async deleteBatched(cutoff: Date): Promise<number> {
    const batchSize = 1000;
    let total = 0;
    for (;;) {
      const rows: Array<{ id: number }> = await this.dataSource.query(
        `SELECT id FROM platform_link_audit_events
         WHERE created_at < $1
         ORDER BY id ASC LIMIT $2`,
        [cutoff, batchSize],
      );
      if (rows.length === 0) break;

      const result = await this.dataSource.query(
        `DELETE FROM platform_link_audit_events
         WHERE id = ANY($1::int[])`,
        [rows.map((row) => row.id)],
      );
      total += result.rowCount ?? result.affected ?? 0;
      if (rows.length < batchSize) break;
    }
    return total;
  }
}
