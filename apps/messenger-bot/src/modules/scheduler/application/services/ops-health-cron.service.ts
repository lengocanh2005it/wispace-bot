import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OpsHealthService } from './ops-health.service';
import { BotMetricsService } from '@wispace/bot-metrics';

@Injectable()
export class OpsHealthCronService {
  private readonly logger = new Logger(OpsHealthCronService.name);

  constructor(
    private readonly opsHealthService: OpsHealthService,
    @Optional() private readonly metrics?: BotMetricsService,
  ) {
    if (this.opsHealthService.isAlertCronEnabled()) {
      this.metrics?.registerCron?.('ops-health-daily', 24 * 60 * 60 * 1000);
    }
  }

  @Cron('0 0 9 * * *', {
    name: 'ops-health-daily',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleDailyOpsHealthCron(): Promise<void> {
    if (!this.opsHealthService.isAlertCronEnabled()) {
      this.logger.log(
        'OPS_HEALTH_ALERT_ENABLED=false; skip daily ops health cron',
      );
      return;
    }

    try {
      await this.opsHealthService.logSnapshotIfNeeded();
      this.metrics?.recordCronSuccess?.('ops-health-daily');
    } catch (error) {
      this.logger.error('Daily ops health check failed', error);
    }
  }
}
