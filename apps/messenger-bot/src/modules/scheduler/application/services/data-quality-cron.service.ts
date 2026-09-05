import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import {
  isDataQualityCronEnabled,
  DataQualityService,
  type DataQualityCheckResult,
} from '@wispace/ops-health';
import { BotMetricsService } from '@wispace/bot-metrics';

@Injectable()
export class DataQualityCronService {
  private readonly logger = new Logger(DataQualityCronService.name);

  constructor(
    private readonly dataQualityService: DataQualityService,
    private readonly configService: ConfigService,
    @Optional() private readonly metrics?: BotMetricsService,
  ) {
    if (
      isDataQualityCronEnabled((key) => this.configService.get<string>(key))
    ) {
      this.metrics?.registerCron?.('data-quality-daily', 24 * 60 * 60 * 1000);
    }
  }

  @Cron('0 15 9 * * *', {
    name: 'data-quality-daily',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleDailyDataQualityCron(): Promise<void> {
    if (
      !isDataQualityCronEnabled((key) => this.configService.get<string>(key))
    ) {
      this.logger.log(
        'DATA_QUALITY_CRON_ENABLED=false; skip daily data-quality check',
      );
      return;
    }

    try {
      const result = await this.dataQualityService.run();
      if (result.status === 'skipped') {
        this.logger.log('DATA_QUALITY_SKIPPED reason=advisory_lock_held');
        return;
      }
      this.metrics?.recordCronSuccess?.('data-quality-daily');

      const failed = result.checks.filter((check) => check.status === 'fail');
      if (failed.length > 0) {
        for (const check of failed) {
          this.logger.warn(this.formatAlert(check));
        }
        this.logger.warn(
          `OPS_HEALTH_SUMMARY dataQualityFailed=${failed.length} dataQualityChecks=${result.checks.length}`,
        );
      } else {
        this.logger.log(
          `OPS_HEALTH_OK dataQualityChecks=${result.checks.length} dataQualityDurationMs=${result.durationMs}`,
        );
      }
    } catch {
      this.logger.error(
        'OPS_HEALTH_ALERT code=DATA_QUALITY_RUN_ERROR reason=query_error',
      );
    }
  }

  private formatAlert(check: DataQualityCheckResult): string {
    const code = `DATA_QUALITY_${check.check.toUpperCase()}`;
    const samples =
      check.sampleKeys.length > 0 ? check.sampleKeys.join(',') : 'none';
    const reason = check.reason ?? 'threshold_exceeded';
    return `OPS_HEALTH_ALERT code=${code} count=${check.count} baseline=${check.baseline ?? 'none'} threshold=${check.threshold ?? 'none'} reason=${reason} samples=${samples}`;
  }
}
