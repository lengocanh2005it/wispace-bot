import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type {
  StudyReminderJobRepositoryPort,
  StudyReminderJob,
  UpsertStudyReminderJobInput,
} from '../ports/study-reminder-job.repository.port';
import { StudyReminderJobEntity } from '../entities/study-reminder-job.entity';

/**
 * TypeORM implementation of StudyReminderJobRepositoryPort.
 * Shared across Discord and Zalo — eliminates the 256-line clone in each app.
 */
@Injectable()
export class TypeormStudyReminderJobRepository implements StudyReminderJobRepositoryPort {
  constructor(
    @InjectRepository(StudyReminderJobEntity)
    private readonly repo: Repository<StudyReminderJobEntity>,
  ) {}

  async upsertPendingJob(
    input: UpsertStudyReminderJobInput,
  ): Promise<StudyReminderJob> {
    const existing = await this.repo.findOne({
      where: {
        platform: input.platform,
        externalUserId: input.externalUserId,
        sessionKey: input.sessionKey,
      },
    });

    if (existing) {
      if (existing.status === 'sent') {
        return this.mapEntity(existing);
      }
      existing.scheduledAt = input.scheduledAt;
      existing.remindAt = input.remindAt;
      existing.topic = input.topic ?? existing.topic;
      existing.status = 'pending';
      existing.retryCount = 0;
      existing.lastError = null;
      existing.nextRetryAt = null;
      if (input.userId != null) {
        existing.userId = input.userId;
      }
      const saved = await this.repo.save(existing);
      return this.mapEntity(saved);
    }

    const created = this.repo.create({
      platform: input.platform,
      externalUserId: input.externalUserId,
      userId: input.userId ?? null,
      sessionKey: input.sessionKey,
      scheduledAt: input.scheduledAt,
      remindAt: input.remindAt,
      topic: input.topic ?? null,
      status: 'pending',
      maxRetries: input.maxRetries,
    });
    const saved = await this.repo.save(created);
    return this.mapEntity(saved);
  }

  async findDueJobs(
    now: Date,
    minLeadMinutes: number,
  ): Promise<StudyReminderJob[]> {
    const minLeadAt = new Date(now.getTime() + minLeadMinutes * 60 * 1000);
    const rows = await this.repo
      .createQueryBuilder('job')
      .where('job.status IN (:...statuses)', {
        statuses: ['pending', 'failed'],
      })
      .andWhere('job.remind_at <= :now', { now })
      .andWhere('job.scheduled_at > :minLeadAt', { minLeadAt })
      .orderBy('job.remind_at', 'ASC')
      .limit(50)
      .getMany();
    return rows.map((r) => this.mapEntity(r));
  }

  async claimJob(jobId: number): Promise<StudyReminderJob | null> {
    const result = await this.repo.update(
      { id: jobId, status: In(['pending', 'failed']) },
      { status: 'processing' },
    );
    if (!result.affected) return null;
    const row = await this.repo.findOne({ where: { id: jobId } });
    return row ? this.mapEntity(row) : null;
  }

  async markSent(jobId: number): Promise<void> {
    await this.repo.update(jobId, {
      status: 'sent',
      sentAt: new Date(),
      nextRetryAt: null,
      lastError: null,
    });
  }

  async markFailed(params: {
    jobId: number;
    errorMessage: string;
    retryCount: number;
    nextRetryAt?: Date;
    terminal: boolean;
  }): Promise<void> {
    await this.repo.update(params.jobId, {
      status: 'failed',
      retryCount: params.retryCount,
      lastError: params.errorMessage,
      nextRetryAt: params.terminal ? null : (params.nextRetryAt ?? null),
    });
  }

  async markCancelled(jobId: number, reason?: string): Promise<void> {
    void reason; // reserved for audit logging
    await this.repo.update(jobId, { status: 'cancelled' });
  }

  async cancelStaleJobsForExternalUserId(
    platform: string,
    externalUserId: string,
    activeSessionKeys: string[],
    horizonEnd?: Date,
  ): Promise<number> {
    if (activeSessionKeys.length === 0) return 0;
    const qb = this.repo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set({ status: 'cancelled' })
      .where('platform = :platform', { platform })
      .andWhere('externalUserId = :externalUserId', { externalUserId })
      .andWhere('sessionKey NOT IN (:...keys)', { keys: activeSessionKeys })
      .andWhere('status IN (:...statuses)', {
        statuses: ['pending', 'failed'],
      });
    if (horizonEnd) {
      qb.andWhere('scheduled_at <= :horizonEnd', { horizonEnd });
    }
    const result = await qb.execute();
    return result.affected ?? 0;
  }

  async cancelJobsFromOtherPlatforms(
    userId: number,
    currentPlatform: string,
  ): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set({ status: 'cancelled' })
      .where('userId = :userId', { userId })
      .andWhere('platform != :platform', { platform: currentPlatform })
      .andWhere('status IN (:...statuses)', {
        statuses: ['pending', 'failed'],
      })
      .execute();
    return result.affected ?? 0;
  }

  async findNextDueTime(now: Date): Promise<Date | null> {
    const row = await this.repo
      .createQueryBuilder('job')
      .where('job.status IN (:...statuses)', {
        statuses: ['pending', 'failed'],
      })
      .andWhere('job.remind_at > :now', { now })
      .orderBy('job.remind_at', 'ASC')
      .select('job.remind_at')
      .limit(1)
      .getOne();
    return row?.remindAt ?? null;
  }

  async resetStuckProcessingJobs(olderThan: Date): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set({ status: 'failed' })
      .where('status = :status', { status: 'processing' })
      .andWhere('updated_at < :olderThan', { olderThan })
      .execute();
    return result.affected ?? 0;
  }

  async deleteSentJobs(olderThan: Date): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .where('status = :status', { status: 'sent' })
      .andWhere('sent_at < :olderThan', { olderThan })
      .execute();
    return result.affected ?? 0;
  }

  async deleteTerminalJobsOlderThan(olderThan: Date): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .where('status IN (:...statuses)', {
        statuses: ['cancelled', 'failed'],
      })
      .andWhere('retry_count >= max_retries')
      .andWhere('updated_at < :olderThan', { olderThan })
      .execute();
    return result.affected ?? 0;
  }

  async countJobsByStatus(platform: string): Promise<Record<string, number>> {
    const rows = await this.repo
      .createQueryBuilder('job')
      .select('job.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('job.platform = :platform', { platform })
      .groupBy('job.status')
      .getRawMany<{ status: string; count: string }>();
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.status] = parseInt(row.count, 10);
    }
    return result;
  }

  async countTerminalFailedSince(since: Date): Promise<number> {
    return this.repo
      .createQueryBuilder('job')
      .where('job.status = :status', { status: 'failed' })
      .andWhere('job.retry_count >= job.max_retries')
      .andWhere('job.updated_at >= :since', { since })
      .getCount();
  }

  async findStuckProcessing(
    olderThan: Date,
    limit?: number,
  ): Promise<StudyReminderJob[]> {
    const qb = this.repo
      .createQueryBuilder('job')
      .where('job.status = :status', { status: 'processing' })
      .andWhere('job.updated_at < :olderThan', { olderThan });
    if (limit) {
      qb.limit(limit);
    }
    const rows = await qb.getMany();
    return rows.map((r) => this.mapEntity(r));
  }

  private mapEntity(entity: StudyReminderJobEntity): StudyReminderJob {
    return {
      id: entity.id,
      platform: entity.platform,
      externalUserId: entity.externalUserId,
      userId: entity.userId ?? undefined,
      sessionKey: entity.sessionKey,
      scheduledAt: entity.scheduledAt,
      remindAt: entity.remindAt,
      topic: entity.topic ?? undefined,
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
