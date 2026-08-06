import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ReportClaimRepositoryPort } from '@wispace/scheduler-core';
import { ScheduledReportClaimEntity } from '@wispace/database';

const PLATFORM = 'zalo' as const;

@Injectable()
export class ZaloReportClaimRepository implements ReportClaimRepositoryPort {
  constructor(
    @InjectRepository(ScheduledReportClaimEntity)
    private readonly claimRepo: Repository<ScheduledReportClaimEntity>,
  ) {}

  async hasSentScheduledReportToday(externalUserId: string): Promise<boolean> {
    const reportDate = new Date().toISOString().slice(0, 10);
    const claim = await this.claimRepo.findOne({
      where: {
        platform: PLATFORM,
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

  async tryClaimScheduledReport(params: {
    externalUserId: string;
    userId?: number;
    reportDate: string;
  }): Promise<boolean> {
    try {
      await this.claimRepo.save({
        platform: PLATFORM,
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
        platform: PLATFORM,
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
        platform: PLATFORM,
        externalUserId: params.externalUserId,
        reportDate: params.reportDate,
        status: 'claimed',
      },
      { status: 'released' },
    );
  }
}
