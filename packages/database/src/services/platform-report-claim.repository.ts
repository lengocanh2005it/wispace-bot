import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { ReportClaimRepositoryPort } from '@wispace/scheduler-core';
import { todayReportDate } from '@wispace/scheduler-core';
import { ScheduledReportClaimEntity } from '../entities/scheduled-report-claim.entity';
import { LearnerScheduledReportClaimEntity } from '../entities/learner-scheduled-report-claim.entity';
import type { OutboundDeliveryOutcome, Platform } from '@wispace/contracts';
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
    @Optional()
    @InjectRepository(LearnerScheduledReportClaimEntity)
    private readonly learnerClaimRepo?: Repository<LearnerScheduledReportClaimEntity>,
  ) {}

  async hasSentScheduledReportToday(
    externalUserId: string,
    userId?: number,
  ): Promise<boolean> {
    const reportDate = todayReportDate();
    if (this.learnerClaimRepo) {
      const learnerClaim = await this.learnerClaimRepo.findOne({
        where: {
          ...(userId !== undefined
            ? { userId }
            : { platform: this.platform, externalUserId }),
          reportDate,
          reportType: 'scheduled',
          status: 'sent',
        },
      });
      if (learnerClaim) return true;
    }
    const claim = await this.claimRepo.findOne({
      where:
        userId === undefined
          ? {
              platform: this.platform,
              externalUserId,
              reportDate,
              status: 'sent',
            }
          : [
              {
                platform: this.platform,
                externalUserId,
                reportDate,
                status: 'sent',
                userId,
              },
              {
                platform: this.platform,
                externalUserId,
                reportDate,
                status: 'sent',
                userId: IsNull(),
              },
            ],
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
    if (claim) return true;
    if (!this.learnerClaimRepo) return false;
    const learnerClaim = await this.learnerClaimRepo.findOne({
      where: { userId, reportDate, reportType: 'scheduled', status: 'sent' },
    });
    return !!learnerClaim;
  }

  async listUserIdsWithSentReportToday(reportDate: string): Promise<number[]> {
    const ids = await listUserIdsWithSentReport(this.claimRepo, reportDate);
    if (!this.learnerClaimRepo) return ids;
    const learnerClaims = await this.learnerClaimRepo.find({
      where: { reportDate, reportType: 'scheduled', status: 'sent' },
      select: { userId: true },
    });
    return [
      ...new Set([...ids, ...learnerClaims.map((claim) => claim.userId)]),
    ];
  }

  async tryClaimScheduledReport(
    params: {
      externalUserId: string;
      userId?: number;
      reportDate: string;
    },
    leaseMs: number,
  ): Promise<{
    claimed: boolean;
    leaseToken?: string;
    deliveryRecord?: string;
    deliveryKey?: string;
  }> {
    if (params.userId !== undefined && this.learnerClaimRepo) {
      const rows: Array<{
        lease_token: string;
        delivery_record: string | null;
        delivery_key: string | null;
      }> = await this.learnerClaimRepo.manager.query(
        `
          INSERT INTO learner_scheduled_report_claims
            (user_id, report_date, report_type, platform, external_user_id,
             status, lease_token, lease_expires_at)
          SELECT $1, $2::date, 'scheduled', $3, $4, 'claimed', gen_random_uuid(),
                 now() + ($5::int * interval '1 millisecond')
          WHERE NOT EXISTS (
            SELECT 1 FROM scheduled_report_claims legacy
            WHERE legacy.platform = $3
              AND legacy.external_user_id = $4
              AND legacy.report_date = $2::date
              AND (legacy.user_id = $1 OR legacy.user_id IS NULL)
              AND legacy.status IN ('claimed', 'sent')
          )
          ON CONFLICT (user_id, report_date, report_type)
          DO UPDATE SET
            platform = EXCLUDED.platform,
            external_user_id = EXCLUDED.external_user_id,
            status = 'claimed',
            lease_token = EXCLUDED.lease_token,
            lease_expires_at = EXCLUDED.lease_expires_at,
            updated_at = now()
          WHERE learner_scheduled_report_claims.status = 'released'
          RETURNING lease_token, delivery_record, delivery_key
        `,
        [
          params.userId,
          params.reportDate,
          this.platform,
          params.externalUserId,
          leaseMs,
        ],
      );

      return rows.length > 0
        ? {
            claimed: true,
            leaseToken: rows[0].lease_token,
            deliveryRecord: rows[0].delivery_record ?? undefined,
            deliveryKey: rows[0].delivery_key ?? undefined,
          }
        : { claimed: false };
    }

    // ON CONFLICT DO UPDATE ... WHERE status = 'released': reclaims a claim
    // released after a transient failure (claim -> release -> claim must
    // succeed), while an active `claimed` row is never stolen by a concurrent
    // worker and a `sent` claim stays non-reclaimable. Only a genuine
    // duplicate claim returns false — any other DB failure propagates instead
    // of masquerading as "already claimed" (a DB blip during the 08:00 cron
    // must not silently skip users).
    if (params.userId) {
      const activeOther = await this.claimRepo
        .createQueryBuilder('claim')
        .where('claim.user_id = :userId', { userId: params.userId })
        .andWhere('claim.report_date = :reportDate', {
          reportDate: params.reportDate,
        })
        .andWhere('claim.platform != :platform', { platform: this.platform })
        .andWhere(
          "(claim.status = 'sent' OR (claim.status = 'claimed' AND (claim.lease_expires_at > now() OR claim.lease_expires_at IS NULL)))",
        )
        .getOne();

      if (activeOther) {
        return { claimed: false };
      }
    }

    const rows: Array<{
      id: number;
      lease_token: string;
      delivery_record: string | null;
      delivery_key: string | null;
    }> = await this.claimRepo.manager.query(
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
      RETURNING id, lease_token, delivery_record, delivery_key
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
      ? {
          claimed: true,
          leaseToken: rows[0].lease_token,
          deliveryRecord: rows[0].delivery_record ?? undefined,
          deliveryKey: rows[0].delivery_key ?? undefined,
        }
      : { claimed: false };
  }

  async markScheduledReportClaimSent(
    params: {
      externalUserId: string;
      reportDate: string;
      userId?: number;
    },
    leaseToken: string,
    deliveryRecord?: string,
    deliveryKey?: string,
    deliveryStatus?: OutboundDeliveryOutcome,
  ): Promise<boolean> {
    if (params.userId !== undefined && this.learnerClaimRepo) {
      const result = await this.learnerClaimRepo
        .createQueryBuilder()
        .update()
        .set({
          status: 'sent',
          ...(deliveryRecord !== undefined ? { deliveryRecord } : {}),
          ...(deliveryKey !== undefined ? { deliveryKey } : {}),
          ...(deliveryStatus !== undefined ? { deliveryStatus } : {}),
        })
        .where('user_id = :userId', { userId: params.userId })
        .andWhere('report_date = :reportDate', {
          reportDate: params.reportDate,
        })
        .andWhere('report_type = :reportType', { reportType: 'scheduled' })
        .andWhere('status = :status', { status: 'claimed' })
        .andWhere('lease_token = :leaseToken', { leaseToken })
        .execute();

      if ((result.affected ?? 0) > 0) return true;
    }

    const result = await this.claimRepo
      .createQueryBuilder()
      .update()
      .set({
        status: 'sent',
        ...(deliveryRecord !== undefined ? { deliveryRecord } : {}),
        ...(deliveryKey !== undefined ? { deliveryKey } : {}),
        ...(deliveryStatus !== undefined ? { deliveryStatus } : {}),
      })
      .where('platform = :platform', { platform: this.platform })
      .andWhere('external_user_id = :externalUserId', {
        externalUserId: params.externalUserId,
      })
      .andWhere(
        params.userId !== undefined ? 'user_id = :userId' : 'TRUE',
        params.userId !== undefined ? { userId: params.userId } : {},
      )
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
      userId?: number;
    },
    leaseToken: string,
  ): Promise<boolean> {
    if (params.userId !== undefined && this.learnerClaimRepo) {
      const result = await this.learnerClaimRepo
        .createQueryBuilder()
        .update()
        .set({ status: 'released' })
        .where('user_id = :userId', { userId: params.userId })
        .andWhere('report_date = :reportDate', {
          reportDate: params.reportDate,
        })
        .andWhere('report_type = :reportType', { reportType: 'scheduled' })
        .andWhere('status = :status', { status: 'claimed' })
        .andWhere('lease_token = :leaseToken', { leaseToken })
        .execute();
      if ((result.affected ?? 0) > 0) return true;
    }

    const result = await this.claimRepo
      .createQueryBuilder()
      .update()
      .set({ status: 'released' })
      .where('platform = :platform', { platform: this.platform })
      .andWhere('external_user_id = :externalUserId', {
        externalUserId: params.externalUserId,
      })
      .andWhere(
        params.userId !== undefined ? 'user_id = :userId' : 'TRUE',
        params.userId !== undefined ? { userId: params.userId } : {},
      )
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

    let released = result.affected ?? 0;
    if (this.learnerClaimRepo) {
      const learnerResult = await this.learnerClaimRepo
        .createQueryBuilder()
        .update()
        .set({ status: 'released', updatedAt: now })
        .where('status = :status', { status: 'claimed' })
        .andWhere(
          '(lease_expires_at < :now OR (lease_expires_at IS NULL AND updated_at < :olderThan))',
          { now, olderThan },
        )
        .execute();
      released += learnerResult.affected ?? 0;
    }
    return released;
  }
}
