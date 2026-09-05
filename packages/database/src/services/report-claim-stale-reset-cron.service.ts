import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { subMilliseconds } from 'date-fns';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import {
  REPORT_CLAIM_REPOSITORY,
  type ReportClaimRepositoryPort,
} from '@wispace/scheduler-core';
import type { Platform } from '@wispace/contracts';
import type { CronHeartbeatMetricsPort } from './platform-dead-letter-cron.service';

export const DEFAULT_REPORT_CLAIM_LEASE_MS = 2 * 60 * 60 * 1000;

export function readReportClaimLeaseMs(configService: ConfigService): number {
  const raw = configService.get<string>('REPORT_CLAIM_STALE_RESET_MS');
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_REPORT_CLAIM_LEASE_MS;
}

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
    private readonly configService: ConfigService,
    @Inject(REPORT_CLAIM_REPOSITORY)
    private readonly claimRepository: ReportClaimRepositoryPort,
    private readonly pgLock: PgAdvisoryLockService,
    private readonly options: ReportClaimStaleResetCronOptions,
  ) {
    this.options.metrics?.registerCron(
      'report-claims-stale-reset',
      30 * 60 * 1000,
    );
  }

  @Cron('*/30 * * * *', { name: 'report-claims-stale-reset' })
  async handleStaleReset(): Promise<void> {
    const staleMs = readReportClaimLeaseMs(this.configService);
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
