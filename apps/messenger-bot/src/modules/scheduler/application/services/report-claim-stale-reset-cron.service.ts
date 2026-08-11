import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { subtractMs } from '@wispace/date-utils';
import { PgAdvisoryLockService } from '@wispace/bot-common';
import {
  REPORT_CLAIM_REPOSITORY,
  type ReportClaimRepositoryPort,
} from '@wispace/scheduler-core';
import { ADVISORY_LOCK } from '@messenger/shared/common/advisory-lock-ids';
import { readEnvPositiveInt } from '@messenger/shared/config/env-helpers';

const DEFAULT_STALE_CLAIM_MS = 2 * 60 * 60 * 1000;

/**
 * Releases `scheduled_report_claims` stuck in `claimed` — a pod crash between
 * claim and mark-sent would otherwise leak the day's dedupe slot forever
 * (same-day ops re-send silently blocked, claim rows accumulate).
 */
@Injectable()
export class ReportClaimStaleResetCronService {
  private readonly logger = new Logger(ReportClaimStaleResetCronService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(REPORT_CLAIM_REPOSITORY)
    private readonly claimRepository: ReportClaimRepositoryPort,
    private readonly pgLock: PgAdvisoryLockService,
  ) {}

  @Cron('*/30 * * * *', {
    name: 'report-claims-stale-reset',
  })
  async handleStaleReset(): Promise<void> {
    const staleMs = readEnvPositiveInt(
      this.configService,
      'REPORT_CLAIM_STALE_RESET_MS',
      DEFAULT_STALE_CLAIM_MS,
    );

    const result = await this.pgLock.withLock(
      ADVISORY_LOCK.REPORT_CLAIM_STALE_RESET,
      () =>
        this.claimRepository.resetStaleScheduledReportClaims?.(
          subtractMs(new Date(), staleMs),
        ) ?? Promise.resolve(0),
    );

    if (result === null) {
      this.logger.debug(
        'report-claims-stale-reset skipped — lock held by another pod',
      );
      return;
    }

    if (result > 0) {
      this.logger.log(
        `report-claims-stale-reset: released ${result} stale claim(s)`,
      );
    }
  }
}
