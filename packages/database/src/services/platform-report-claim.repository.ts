import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ReportClaimRepositoryPort } from '@wispace/scheduler-core';
import { todayReportDate } from '@wispace/scheduler-core';
import { ScheduledReportClaimEntity } from '../entities/scheduled-report-claim.entity';
import type { Platform } from '../types';
import { listUserIdsWithSentReport } from './list-user-ids-with-sent-report';

/**
 * Report claim idempotency for the 08:00 scheduled report cron — shared by
 * Discord and Zalo (replaces their near-identical per-app repositories).
 * Platform (`'discord'` / `'zalo'`) parameterizes the claimed row.
 */
@Injectable()
export class PlatformReportClaimRepository implements ReportClaimRepositoryPort {
  constructor(
    private readonly platform: Platform,
    @InjectRepository(ScheduledReportClaimEntity)
    private readonly claimRepo: Repository<ScheduledReportClaimEntity>,
  ) {}

  async hasSentScheduledReportToday(externalUserId: string): Promise<boolean> {
    const reportDate = todayReportDate();
    const claim = await this.claimRepo.findOne({
      where: {
        platform: this.platform,
        externalUserId,
        reportDate,
        status: 'sent',
      },
    });
    return !!claim;
  }

  async hasAnyPlatformSentReportToday(
    userId: number,
    reportDate: string,
  ): Promise<boolean> {
    const claim = await this.claimRepo.findOne({
      where: { userId, reportDate, status: 'sent' },
    });
    return !!claim;
  }

  async listUserIdsWithSentReportToday(reportDate: string): Promise<number[]> {
    return listUserIdsWithSentReport(this.claimRepo, reportDate);
  }

  async tryClaimScheduledReport(params: {
    externalUserId: string;
    userId?: number;
    reportDate: string;
  }): Promise<boolean> {
    // ON CONFLICT DO NOTHING: only a genuine duplicate claim returns false.
    // Any other DB failure propagates instead of masquerading as "already
    // claimed" (a DB blip during the 08:00 cron must not silently skip users).
    const rows: Array<{ id: number }> = await this.claimRepo.manager.query(
      `
      INSERT INTO scheduled_report_claims (platform, external_user_id, report_date, user_id, status)
      VALUES ($1, $2, $3::date, $4, 'claimed')
      ON CONFLICT (platform, external_user_id, report_date) DO NOTHING
      RETURNING id
    `,
      [this.platform, params.externalUserId, params.reportDate, params.userId ?? null],
    );

    return rows.length > 0;
  }

  async markScheduledReportClaimSent(params: {
    externalUserId: string;
    reportDate: string;
  }): Promise<void> {
    await this.claimRepo.update(
      {
        platform: this.platform,
        externalUserId: params.externalUserId,
        reportDate: params.reportDate,
      },
      { status: 'sent' },
    );
  }

  async releaseScheduledReportClaim(params: {
    externalUserId: string;
    reportDate: string;
  }): Promise<void> {
    await this.claimRepo.update(
      {
        platform: this.platform,
        externalUserId: params.externalUserId,
        reportDate: params.reportDate,
        status: 'claimed',
      },
      { status: 'released' },
    );
  }
}
