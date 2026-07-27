import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type {
  ReportSendJobRepositoryPort,
  ReportSendJob,
  ReportSendJobCreateParams,
  ReportSendJobUpdateParams,
} from '@wispace/scheduler-core';
import { ReportSendJobEntity } from '../../../../infrastructure/database/entities/report-send-job.entity';

/** This repository only ever writes rows for the Messenger bot. */
const PLATFORM = 'messenger' as const;

@Injectable()
export class ReportSendJobRepository implements ReportSendJobRepositoryPort {
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
      existing.lastError = params.errorMessage;
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
      lastError: params.errorMessage,
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

  async claimJob(jobId: number): Promise<ReportSendJob | null> {
    const result = await this.jobRepo.update(
      {
        id: jobId,
        status: 'failed',
      },
      { status: 'processing' },
    );

    if (!result.affected) {
      return null;
    }

    const row = await this.jobRepo.findOne({ where: { id: jobId } });
    return row ? this.mapEntity(row) : null;
  }

  async markSent(jobId: number): Promise<void> {
    await this.jobRepo.update(jobId, {
      status: 'sent',
      sentAt: new Date(),
      nextRetryAt: null,
      lastError: null,
    });
  }

  async markFailed(params: ReportSendJobUpdateParams): Promise<void> {
    await this.jobRepo.update(params.jobId, {
      status: 'failed',
      retryCount: params.retryCount,
      lastError: params.errorMessage,
      nextRetryAt: params.terminal ? null : (params.nextRetryAt ?? null),
    });
  }

  async markSentByPsidExamDate(psid: string, examDate: string): Promise<void> {
    await this.jobRepo.update(
      {
        platform: PLATFORM,
        externalUserId: psid,
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
    const result = await this.jobRepo
      .createQueryBuilder()
      .update(ReportSendJobEntity)
      .set({ status: 'failed' })
      .where('status = :status', { status: 'processing' })
      .andWhere('updated_at < :olderThan', { olderThan })
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
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
