import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { truncatePersistedError } from '@wispace/bot-common/masking';
import type {
  ReportSendJobRepositoryPort,
  ReportSendJob,
  ReportSendJobCreateParams,
  ReportSendJobUpdateParams,
} from '@wispace/scheduler-core';
import { ReportSendJobEntity } from '@wispace/database';

const PLATFORM = 'discord' as const;

@Injectable()
export class DiscordReportSendJobRepository implements ReportSendJobRepositoryPort {
  private readonly logger = new Logger(DiscordReportSendJobRepository.name);

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
      existing.status = 'failed';
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
      status: 'failed',
      retryCount: nextRetryCount,
      maxRetries: params.maxRetries,
      nextRetryAt: terminal ? null : params.nextRetryAt,
      lastError: truncatePersistedError(params.errorMessage),
    });

    const saved = await this.jobRepo.save(created);
    return this.mapEntity(saved);
  }

  async findDueJobs(now: Date, limit = 50): Promise<ReportSendJob[]> {
    const rows = await this.jobRepo
      .createQueryBuilder('job')
      .where('job.platform = :platform', { platform: PLATFORM })
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
    // Assign a fresh lease token + expiry so recovery (which reopens only
    // expired leases) and stale owners (whose token no longer matches) can
    // never double-send or overwrite a newer owner's result.
    const result = await this.jobRepo.update(
      {
        id: jobId,
        platform: PLATFORM,
        status: 'failed',
      },
      {
        status: 'processing',
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + leaseMs),
      },
    );

    if (!result.affected) return null;

    const row = await this.jobRepo.findOne({ where: { id: jobId } });
    return row ? this.mapEntity(row) : null;
  }

  async markSent(jobId: number, leaseToken: string): Promise<void> {
    const result = await this.jobRepo.update(
      { id: jobId, leaseToken },
      {
        status: 'sent',
        sentAt: new Date(),
        nextRetryAt: null,
        lastError: null,
      },
    );
    if (!result.affected) {
      this.logger.warn(
        `markSent ignored for jobId=${jobId}: lease token mismatch (stale owner)`,
      );
    }
  }

  async markFailed(params: ReportSendJobUpdateParams): Promise<void> {
    const where = params.leaseToken
      ? { id: params.jobId, leaseToken: params.leaseToken }
      : { id: params.jobId };
    const result = await this.jobRepo.update(where, {
      status: 'failed',
      retryCount: params.retryCount,
      lastError: truncatePersistedError(params.errorMessage),
      nextRetryAt: params.terminal ? null : (params.nextRetryAt ?? null),
    });
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
      .where('platform = :platform', { platform: PLATFORM })
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
      .where('job.platform = :platform', { platform: PLATFORM })
      .andWhere('job.status = :status', { status: 'failed' })
      .andWhere('job.retry_count >= job.max_retries')
      .andWhere('job.updated_at >= :since', { since })
      .getCount();
  }

  private mapEntity(entity: ReportSendJobEntity): ReportSendJob {
    return {
      id: entity.id,
      platform: entity.platform,
      externalUserId: entity.externalUserId,
      userId: entity.userId ?? undefined,
      examDate: entity.examDate,
      firstAttemptDate: entity.firstAttemptDate,
      status: entity.status,
      retryCount: entity.retryCount,
      maxRetries: entity.maxRetries,
      nextRetryAt: entity.nextRetryAt ?? undefined,
      lastError: entity.lastError ?? undefined,
      sentAt: entity.sentAt ?? undefined,
      leaseToken: entity.leaseToken ?? undefined,
      leaseExpiresAt: entity.leaseExpiresAt ?? undefined,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
