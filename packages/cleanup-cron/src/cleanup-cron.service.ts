import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface CleanupCronConfig {
  /** Name for logging (e.g., 'llm-usage-cleanup') */
  name: string;
  /** Advisory lock ID for multi-pod safety */
  advisoryLockId: number;
  /** Cron expression (e.g., '0 0 3 * * *') */
  cronExpression: string;
  /** Timezone for cron (default: 'Asia/Ho_Chi_Minh') */
  timeZone?: string;
  /** Config key for enabled toggle */
  enabledConfigKey: string;
  /** Config key for retention days */
  retentionDaysConfigKey: string;
  /** Default retention days if config not set */
  defaultRetentionDays: number;
}

export interface CleanupResult {
  deleted: number;
  cutoff: Date;
}

/**
 * Generic cleanup cron service for deleting old records from any table.
 * Configurable via CleanupCronConfig. Uses PostgreSQL advisory lock for multi-pod safety.
 */
@Injectable()
export class CleanupCronService {
  private readonly logger = new Logger(CleanupCronService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Execute cleanup with advisory lock protection.
   * @param config - Cleanup configuration
   * @param deleteFn - Function that deletes records older than cutoff, returns count
   * @param isEnabled - Function to check if cleanup is enabled
   * @param getRetentionDays - Function to get retention days from config
   */
  async execute(
    config: CleanupCronConfig,
    deleteFn: (cutoff: Date) => Promise<number>,
    isEnabled: () => boolean,
    getRetentionDays: () => number,
  ): Promise<CleanupResult | null> {
    if (!isEnabled()) {
      return null;
    }

    const retentionDays = getRetentionDays();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();

    try {
      const rows = (await runner.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
        [config.advisoryLockId],
      )) as Array<{ acquired: boolean }>;

      if (!rows[0]?.acquired) {
        this.logger.debug(
          `${config.name}: advisory lock not acquired — another pod holds it`,
        );
        return null;
      }

      try {
        const deleted = await deleteFn(cutoff);
        if (deleted > 0) {
          this.logger.log(
            `${config.name}: deleted ${deleted} row(s) older than ${retentionDays} day(s) (before ${cutoff.toISOString()})`,
          );
        }
        return { deleted, cutoff };
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1::bigint)', [
          config.advisoryLockId,
        ]);
      }
    } finally {
      await runner.release();
    }
  }
}
