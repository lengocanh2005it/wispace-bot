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

  async tryClaimScheduledReport(
    params: {
      externalUserId: string;
      userId?: number;
      reportDate: string;
    },
    leaseMs: number,
  ): Promise<{ claimed: boolean; leaseToken?: string }> {
    // ON CONFLICT DO UPDATE ... WHERE status = 'released': reclaims a claim
    // released after a transient failure (claim -> release -> claim must
    // succeed), while an active `claimed` row is never stolen by a concurrent
    // worker and a `sent` claim stays non-reclaimable. Only a genuine
    // duplicate claim returns false — any other DB failure propagates instead
    // of masquerading as "already claimed" (a DB blip during the 08:00 cron
    // must not silently skip users).
    const rows: Array<{ id: number; lease_token: string }> =
      await this.claimRepo.manager.query(
        `
      INSERT INTO scheduled_report_claims
        (platform, external_user_id, report_date, user_id, status, lease_token, lease_expires_at)
      VALUES ($1, $2, $3::date, $4, 'claimed', gen_random_uuid(), now() + ($5::int * interval '1 millisecond'))
      ON CONFLICT (platform, external_user_id, report_date)
      DO UPDATE SET
        status = 'claimed',
        user_id = EXCLUDED.user_id,
        lease_token = EXCLUDED.lease_token,
        lease_expires_at = EXCLUDED.lease_expires_at,
        updated_at = now()
      WHERE scheduled_report_claims.status = 'released'
      RETURNING id, lease_token
    `,
        [
          this.platform,
          params.externalUserId,
          params.reportDate,
          params.userId ?? null,
          leaseMs,
        ],
      );

    return rows.length > 0
      ? { claimed: true, leaseToken: rows[0].lease_token }
      : { claimed: false };
  }

  async markScheduledReportClaimSent(
    params: {
      externalUserId: string;
      reportDate: string;
    },
    leaseToken: string,
  ): Promise<boolean> {
    const result = await this.claimRepo
      .createQueryBuilder()
      .update()
      .set({ status: 'sent' })
      .where('platform = :platform', { platform: this.platform })
      .andWhere('external_user_id = :externalUserId', {
        externalUserId: params.externalUserId,
      })
      .andWhere('report_date = :reportDate', { reportDate: params.reportDate })
      .andWhere('status = :status', { status: 'claimed' })
      .andWhere('lease_token = :leaseToken', { leaseToken })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  async releaseScheduledReportClaim(
    params: {
      externalUserId: string;
      reportDate: string;
    },
    leaseToken: string,
  ): Promise<boolean> {
    const result = await this.claimRepo
      .createQueryBuilder()
      .update()
      .set({ status: 'released' })
      .where('platform = :platform', { platform: this.platform })
      .andWhere('external_user_id = :externalUserId', {
        externalUserId: params.externalUserId,
      })
      .andWhere('report_date = :reportDate', { reportDate: params.reportDate })
      .andWhere('status = :status', { status: 'claimed' })
      .andWhere('lease_token = :leaseToken', { leaseToken })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  async releaseExpiredScheduledReportClaims(
    now: Date,
    olderThan: Date,
  ): Promise<number> {
    const result = await this.claimRepo
      .createQueryBuilder()
      .update()
      .set({ status: 'released', updatedAt: now })
      .where('platform = :platform', { platform: this.platform })
      .andWhere('status = :status', { status: 'claimed' })
      .andWhere(
        '(lease_expires_at < :now OR (lease_expires_at IS NULL AND updated_at < :olderThan))',
        { now, olderThan },
      )
      .execute();

    return result.affected ?? 0;
  }
}
