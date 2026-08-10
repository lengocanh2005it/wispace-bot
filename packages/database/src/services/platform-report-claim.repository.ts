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
    try {
      await this.claimRepo.save({
        platform: this.platform,
        externalUserId: params.externalUserId,
        userId: params.userId ?? null,
        reportDate: params.reportDate,
        status: 'claimed',
      });
      return true;
    } catch {
      return false;
    }
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
