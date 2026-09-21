import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { truncatePersistedError } from '@wispace/bot-common/masking';
import { extractQueryRows } from '@wispace/bot-common/utils';
import type { Platform } from '@wispace/contracts';
import type {
  ReportSendJob,
  ReportSendJobCreateParams,
  ReportSendJobRepositoryPort,
  ReportSendJobUpdateParams,
} from '@wispace/scheduler-core/core';
import { ReportSendJobEntity } from '../entities/report-send-job.entity';

/** Platform-parameterized TypeORM persistence for the report-send outbox. */
@Injectable()
export class PlatformReportSendJobRepository implements ReportSendJobRepositoryPort {
  private readonly logger = new Logger(PlatformReportSendJobRepository.name);

  constructor(
    private readonly platform: Platform,
    @InjectRepository(ReportSendJobEntity)
    private readonly jobRepo: Repository<ReportSendJobEntity>,
  ) {}

  async recordRetryableFailure(
    params: ReportSendJobCreateParams,
  ): Promise<ReportSendJob> {
    const existing = await this.jobRepo.findOne({
      where: {
        platform: this.platform,
        externalUserId: params.externalUserId,
        examDate: params.examDate,
      },
    });

    if (existing?.status === 'sent') {
      return this.mapEntity(existing);
    }

    const nextRetryCount = (existing?.retryCount ?? 0) + 1;
    const terminal = nextRetryCount >= params.maxRetries;

    if (existing) {
      existing.retryCount = nextRetryCount;
      existing.maxRetries = params.maxRetries;
      existing.lastError = truncatePersistedError(params.errorMessage);
      existing.retryCause = params.retryCause ?? null;
      existing.nextRetryAt = terminal ? null : params.nextRetryAt;
      existing.status = 'failed';
      if (params.userId != null) {
        existing.userId = params.userId;
      }

      const saved = await this.jobRepo.save(existing);
      return this.mapEntity(saved);
    }

    const created = this.jobRepo.create({
      platform: this.platform,
      externalUserId: params.externalUserId,
      userId: params.userId ?? null,
      examDate: params.examDate,
      firstAttemptDate: params.firstAttemptDate,
      status: 'failed',
      retryCount: nextRetryCount,
      maxRetries: params.maxRetries,
      nextRetryAt: terminal ? null : params.nextRetryAt,
      lastError: truncatePersistedError(params.errorMessage),
      retryCause: params.retryCause ?? null,
    });

    const saved = await this.jobRepo.save(created);
    return this.mapEntity(saved);
  }

  async findDueJobs(now: Date, limit = 50): Promise<ReportSendJob[]> {
    const rows = await this.jobRepo
      .createQueryBuilder('job')
      .where('job.platform = :platform', { platform: this.platform })
      .andWhere('job.status = :status', { status: 'failed' })
      .andWhere('job.retry_count < job.max_retries')
      .andWhere('job.next_retry_at IS NOT NULL')
      .andWhere('job.next_retry_at <= :now', { now })
      .orderBy('job.next_retry_at', 'ASC')
      .limit(limit)
      .getMany();

    return rows.map((row) => this.mapEntity(row));
  }

  async claimJob(
    jobId: number,
    leaseMs: number,
  ): Promise<ReportSendJob | null> {
    const rows = extractQueryRows<Record<string, unknown>>(
      await this.jobRepo.query(
        `UPDATE report_send_jobs
         SET status = 'processing',
             lease_token = gen_random_uuid(),
             lease_expires_at = now() + ($3::int * interval '1 millisecond')
         WHERE id = $1
           AND platform = $2
           AND status = 'failed'
         RETURNING *`,
        [jobId, this.platform, leaseMs],
      ),
    );

    return rows.length > 0 ? this.mapEntity(rows[0]) : null;
  }

  async markSent(jobId: number, leaseToken: string): Promise<void> {
    const result = await this.jobRepo
      .createQueryBuilder()
      .update(ReportSendJobEntity)
      .set({
        status: 'sent',
        sentAt: new Date(),
        nextRetryAt: null,
        lastError: null,
        retryCause: null,
      })
      .where('id = :id', { id: jobId })
      .andWhere('platform = :platform', { platform: this.platform })
      .andWhere('lease_token = :leaseToken', { leaseToken })
      .execute();

    if (!result.affected) {
      this.logger.warn(
        `markSent ignored for platform=${this.platform} jobId=${jobId}: lease token mismatch (stale owner)`,
      );
    }
  }

  async markFailed(params: ReportSendJobUpdateParams): Promise<void> {
    const query = this.jobRepo
      .createQueryBuilder()
      .update(ReportSendJobEntity)
      .set({
        status: 'failed',
        retryCount: params.retryCount,
        lastError: truncatePersistedError(params.errorMessage),
        retryCause: params.retryCause ?? null,
        nextRetryAt: params.terminal ? null : (params.nextRetryAt ?? null),
      })
      .where('id = :id', { id: params.jobId })
      .andWhere('platform = :platform', { platform: this.platform });
    if (params.leaseToken) {
      query.andWhere('lease_token = :leaseToken', {
        leaseToken: params.leaseToken,
      });
    }

    const result = await query.execute();
    if (params.leaseToken && !result.affected) {
      this.logger.warn(
        `markFailed ignored for platform=${this.platform} jobId=${params.jobId}: lease token mismatch (stale owner)`,
      );
    }
  }

  async markSentByExternalUserExamDate(
    externalUserId: string,
    examDate: string,
  ): Promise<void> {
    await this.jobRepo.update(
      {
        platform: this.platform,
        externalUserId,
        examDate,
        status: In(['failed', 'processing', 'pending']),
      },
      {
        status: 'sent',
        sentAt: new Date(),
        nextRetryAt: null,
        lastError: null,
        retryCause: null,
      },
    );
  }

  async resetStuckProcessingJobs(olderThan: Date): Promise<number> {
    const result = await this.jobRepo
      .createQueryBuilder()
      .update(ReportSendJobEntity)
      .set({ status: 'failed' })
      .where('platform = :platform', { platform: this.platform })
      .andWhere('status = :status', { status: 'processing' })
      .andWhere(
        '(lease_expires_at < :now OR (lease_expires_at IS NULL AND updated_at < :olderThan))',
        { now: new Date(), olderThan },
      )
      .execute();

    return result.affected ?? 0;
  }

  async countTerminalFailedSince(since: Date): Promise<number> {
    return this.jobRepo
      .createQueryBuilder('job')
      .where('job.platform = :platform', { platform: this.platform })
      .andWhere('job.status = :status', { status: 'failed' })
      .andWhere('job.retry_count >= job.max_retries')
      .andWhere('job.updated_at >= :since', { since })
      .getCount();
  }

  private mapEntity(
    entity: ReportSendJobEntity | Record<string, unknown>,
  ): ReportSendJob {
    const row = entity as ReportSendJobEntity & Record<string, unknown>;
    // Raw query rows use snake_case; TypeORM entity rows use camelCase.
    return {
      id: row.id as number,
      platform: row.platform as string,
      externalUserId: (row.externalUserId ?? row.external_user_id) as string,
      userId: (row.userId ?? row.user_id ?? undefined) as number | undefined,
      examDate: (row.examDate ?? row.exam_date) as string,
      firstAttemptDate: (row.firstAttemptDate ??
        row.first_attempt_date) as string,
      status: row.status as ReportSendJob['status'],
      retryCount: (row.retryCount ?? row.retry_count) as number,
      maxRetries: (row.maxRetries ?? row.max_retries) as number,
      nextRetryAt: (row.nextRetryAt ?? row.next_retry_at ?? undefined) as
        | Date
        | undefined,
      lastError: (row.lastError ?? row.last_error ?? undefined) as
        | string
        | undefined,
      retryCause: (row.retryCause ?? row.retry_cause ?? undefined) as
        | 'capacity_overload'
        | undefined,
      sentAt: (row.sentAt ?? row.sent_at ?? undefined) as Date | undefined,
      leaseToken: (row.leaseToken ?? row.lease_token ?? undefined) as
        | string
        | undefined,
      leaseExpiresAt: (row.leaseExpiresAt ??
        row.lease_expires_at ??
        undefined) as Date | undefined,
      createdAt: (row.createdAt ?? row.created_at) as Date,
      updatedAt: (row.updatedAt ?? row.updated_at) as Date,
    };
  }
}
