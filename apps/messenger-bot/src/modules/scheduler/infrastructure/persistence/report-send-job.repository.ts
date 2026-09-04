import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { truncatePersistedError } from '@wispace/bot-common/masking';
import { extractQueryRows } from '@wispace/bot-common/utils';
import type {
  ReportSendJobRepositoryPort,
  ReportSendJob,
  ReportSendJobCreateParams,
  ReportSendJobUpdateParams,
} from '@wispace/scheduler-core';
import { ReportSendJobEntity } from '@wispace/database';

/** This repository only ever writes rows for the Messenger bot. */
const PLATFORM = 'messenger' as const;

@Injectable()
export class ReportSendJobRepository implements ReportSendJobRepositoryPort {
  private readonly logger = new Logger(ReportSendJobRepository.name);

  constructor(
    @InjectRepository(ReportSendJobEntity)
    private readonly jobRepo: Repository<ReportSendJobEntity>,
  ) {}

  async recordRetryableFailure(
    params: ReportSendJobCreateParams,
  ): Promise<ReportSendJob> {
    const existing = await this.jobRepo.findOne({
      where: {
        platform: PLATFORM,
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
      existing.nextRetryAt = terminal ? null : params.nextRetryAt;
      existing.status = terminal ? 'failed' : 'failed';
      if (params.userId != null) {
        existing.userId = params.userId;
      }

      const saved = await this.jobRepo.save(existing);
      return this.mapEntity(saved);
    }

    const created = this.jobRepo.create({
      platform: PLATFORM,
      externalUserId: params.externalUserId,
      userId: params.userId ?? null,
      examDate: params.examDate,
      firstAttemptDate: params.firstAttemptDate,
      status: nextRetryCount >= params.maxRetries ? 'failed' : 'failed',
      retryCount: nextRetryCount,
      maxRetries: params.maxRetries,
      nextRetryAt:
        nextRetryCount >= params.maxRetries ? null : params.nextRetryAt,
      lastError: truncatePersistedError(params.errorMessage),
    });

    const saved = await this.jobRepo.save(created);
    return this.mapEntity(saved);
  }

  async findDueJobs(now: Date, limit = 50): Promise<ReportSendJob[]> {
    const rows = await this.jobRepo
      .createQueryBuilder('job')
      .where('job.status = :status', { status: 'failed' })
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
    // Assign a fresh lease token + expiry so recovery (which reopens only
    // expired leases) and stale owners (whose token no longer matches) can
    // never double-send or overwrite a newer owner's result.
    const rows = extractQueryRows<Record<string, unknown>>(
      await this.jobRepo.query(
        `UPDATE report_send_jobs
       SET status = 'processing',
           lease_token = gen_random_uuid(),
           lease_expires_at = now() + ($2::int * interval '1 millisecond')
       WHERE id = $1 AND status = 'failed'
       RETURNING *`,
        [jobId, leaseMs],
      ),
    );

    if (!rows.length) {
      return null;
    }

    return this.mapEntity(rows[0] as unknown as ReportSendJobEntity);
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
      })
      .where('id = :id', { id: jobId })
      .andWhere('lease_token = :leaseToken', { leaseToken })
      .execute();
    if (!result.affected) {
      this.logger.warn(
        `markSent ignored for jobId=${jobId}: lease token mismatch (stale owner)`,
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
        nextRetryAt: params.terminal ? null : (params.nextRetryAt ?? null),
      })
      .where('id = :id', { id: params.jobId });
    if (params.leaseToken) {
      query.andWhere('lease_token = :leaseToken', {
        leaseToken: params.leaseToken,
      });
    }
    const result = await query.execute();
    if (params.leaseToken && !result.affected) {
      this.logger.warn(
        `markFailed ignored for jobId=${params.jobId}: lease token mismatch (stale owner)`,
      );
    }
  }

  async markSentByExternalUserExamDate(
    externalUserId: string,
    examDate: string,
  ): Promise<void> {
    await this.jobRepo.update(
      {
        platform: PLATFORM,
        externalUserId,
        examDate,
        status: In(['failed', 'processing', 'pending']),
      },
      {
        status: 'sent',
        sentAt: new Date(),
        nextRetryAt: null,
        lastError: null,
      },
    );
  }

  async resetStuckProcessingJobs(olderThan: Date): Promise<number> {
    // Reopen only processing rows whose LEASE expired (live lease = worker
    // still active) or legacy rows (no lease) past the updated_at threshold.
    const result = await this.jobRepo
      .createQueryBuilder()
      .update(ReportSendJobEntity)
      .set({ status: 'failed' })
      .where('status = :status', { status: 'processing' })
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
      .where('job.status = :status', { status: 'failed' })
      .andWhere('job.retry_count >= job.max_retries')
      .andWhere('job.updated_at >= :since', { since })
      .getCount();
  }

  private mapEntity(entity: ReportSendJobEntity): ReportSendJob {
    // Raw query rows (claimJob RETURNING *) arrive with snake_case keys;
    // entity rows carry camelCase properties — read both.
    const row = entity as ReportSendJobEntity & Record<string, unknown>;
    return {
      id: row.id,
      platform: row.platform,
      externalUserId: row.externalUserId ?? row.external_user_id,
      userId:
        row.userId ?? (row.user_id as number | null | undefined) ?? undefined,
      examDate: row.examDate ?? row.exam_date,
      firstAttemptDate: row.firstAttemptDate ?? row.first_attempt_date,
      status: row.status,
      retryCount: row.retryCount ?? row.retry_count,
      maxRetries: row.maxRetries ?? row.max_retries,
      nextRetryAt: (row.nextRetryAt ?? row.next_retry_at ?? undefined) as
        | Date
        | undefined,
      lastError: (row.lastError ?? row.last_error ?? undefined) as
        | string
        | undefined,
      sentAt: (row.sentAt ?? row.sent_at ?? undefined) as Date | undefined,
      leaseToken: (row.leaseToken ?? row.lease_token ?? undefined) as
        | string
        | undefined,
      leaseExpiresAt: (row.leaseExpiresAt ??
        row.lease_expires_at ??
        undefined) as Date | undefined,
      createdAt: row.createdAt ?? row.created_at,
      updatedAt: row.updatedAt ?? row.updated_at,
    };
  }
}
