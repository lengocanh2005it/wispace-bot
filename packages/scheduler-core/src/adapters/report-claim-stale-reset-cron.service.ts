import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { subMilliseconds } from 'date-fns';
import type { CronHeartbeatMetricsPort } from '@wispace/bot-common/cron';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import type { Platform } from '@wispace/contracts';
import {
  REPORT_CLAIM_REPOSITORY,
  type ReportClaimRepositoryPort,
} from '../ports/report-claim.repository.port';
import { ReportSendScheduleService } from '../services/report-send-schedule.service';

export interface ReportClaimStaleResetCronOptions {
  platform: Platform;
  lockId: number;
  metrics?: CronHeartbeatMetricsPort;
}

/** Releases expired scheduled-report claims for one platform per tick. */
@Injectable()
export class ReportClaimStaleResetCronService {
  private readonly logger = new Logger(ReportClaimStaleResetCronService.name);

  constructor(
    @Inject(REPORT_CLAIM_REPOSITORY)
    private readonly claimRepository: ReportClaimRepositoryPort,
    private readonly pgLock: PgAdvisoryLockService,
    private readonly reportSendScheduleService: ReportSendScheduleService,
    private readonly options: ReportClaimStaleResetCronOptions,
  ) {
    this.options.metrics?.registerCron(
      'report-claims-stale-reset',
      30 * 60 * 1000,
    );
  }

  @Cron('*/30 * * * *', { name: 'report-claims-stale-reset' })
  async handleStaleReset(): Promise<void> {
    const staleMs =
      this.reportSendScheduleService.getOutboxSettings().claimLeaseMs;
    const now = new Date();
    const result = await this.pgLock.withLock(this.options.lockId, () =>
      this.claimRepository.releaseExpiredScheduledReportClaims(
        now,
        subMilliseconds(now, staleMs),
      ),
    );

    if (result === null) {
      this.logger.debug(
        `report-claims-stale-reset skipped for ${this.options.platform} — lock held by another pod`,
      );
      return;
    }

    this.options.metrics?.recordCronSuccess('report-claims-stale-reset');

    if (result > 0) {
      this.logger.log(
        `report-claims-stale-reset ${this.options.platform}: released ${result} stale claim(s)`,
      );
    }
  }
}
