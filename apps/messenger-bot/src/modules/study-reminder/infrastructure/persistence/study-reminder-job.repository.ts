import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { StudyReminderJobEntity } from '@wispace/study-reminder-shared';
import {
  StudyReminderJob,
  UpsertStudyReminderJobInput,
} from '../../domain/entities/study-reminder-job.types';
import { StudyReminderJobRepositoryPort } from '../../domain/repositories/study-reminder-job.repository.port';

@Injectable()
export class StudyReminderJobRepository implements StudyReminderJobRepositoryPort {
  constructor(
    @InjectRepository(StudyReminderJobEntity)
    private readonly jobRepo: Repository<StudyReminderJobEntity>,
  ) {}

  async upsertPendingJob(
    input: UpsertStudyReminderJobInput,
  ): Promise<StudyReminderJob> {
    return this.jobRepo.manager.transaction(async (manager) => {
      // Serialize concurrent upserts for the same (psid, session_key) pair.
      // pg_advisory_xact_lock is transaction-scoped — auto-released on commit/rollback.
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `srj:${input.psid}:${input.sessionKey}`,
      ]);

      return this.doUpsert(manager, input);
    });
  }

  private async doUpsert(
    manager: EntityManager,
    input: UpsertStudyReminderJobInput,
  ): Promise<StudyReminderJob> {
    const existing = await manager.findOne(StudyReminderJobEntity, {
      where: {
        platform: input.platform,
        externalUserId: input.psid,
        sessionKey: input.sessionKey,
      },
    });

    if (!existing) {
      const created = manager.create(StudyReminderJobEntity, {
        platform: input.platform,
        externalUserId: input.psid,
        userId: input.userId ?? null,
        sessionKey: input.sessionKey,
        scheduledAt: input.scheduledAt,
        remindAt: input.remindAt,
        topic: input.topic ?? null,
        status: 'pending',
        retryCount: 0,
        maxRetries: input.maxRetries,
        nextRetryAt: null,
        lastError: null,
        sentAt: null,
      });
      const saved = await manager.save(StudyReminderJobEntity, created);
      return this.mapEntity(saved);
    }

    if (existing.status === 'sent') {
      if (!this.hasScheduleChanged(existing, input)) {
        return this.mapEntity(existing);
      }

      this.reopenToPending(existing, input);
      const saved = await manager.save(StudyReminderJobEntity, existing);
      return this.mapEntity(saved);
    }

    if (existing.status === 'cancelled') {
      this.reopenToPending(existing, input);
      const saved = await manager.save(StudyReminderJobEntity, existing);
      return this.mapEntity(saved);
    }

    if (existing.status === 'processing') {
      if (!this.hasScheduleChanged(existing, input)) {
        return this.mapEntity(existing);
      }

      this.reopenToPending(existing, input);
      const saved = await manager.save(StudyReminderJobEntity, existing);
      return this.mapEntity(saved);
    }

    existing.userId = input.userId ?? existing.userId;
    this.applyScheduleUpdate(existing, input);
    existing.maxRetries = input.maxRetries;

    if (existing.status === 'failed') {
      existing.status = 'pending';
      existing.nextRetryAt = null;
      existing.lastError = null;
    }

    const saved = await manager.save(StudyReminderJobEntity, existing);
    return this.mapEntity(saved);
  }

  async cancelStaleJobsForPsid(
    psid: string,
    activeSessionKeys: string[],
    horizonEnd: Date,
    platform: string,
  ): Promise<number> {
    const qb = this.jobRepo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set({ status: 'cancelled' })
      .where('platform = :platform', { platform })
      .andWhere('external_user_id = :psid', { psid })
      .andWhere('status IN (:...statuses)', {
        statuses: ['pending', 'failed', 'processing'],
      })
      .andWhere('scheduled_at <= :horizonEnd', { horizonEnd });

    if (activeSessionKeys.length > 0) {
      qb.andWhere('session_key NOT IN (:...activeSessionKeys)', {
        activeSessionKeys,
      });
    }

    const result = await qb.execute();
    return result.affected ?? 0;
  }

  async findDueJobs(
    now: Date,
    minLeadMinutes: number,
    limit = 50,
  ): Promise<StudyReminderJob[]> {
    const minScheduledAt = new Date(now.getTime() + minLeadMinutes * 60 * 1000);

    const rows = await this.jobRepo
      .createQueryBuilder('job')
      .where('job.status IN (:...statuses)', {
        statuses: ['pending', 'failed'],
      })
      .andWhere('job.remind_at <= :now', { now })
      .andWhere('job.scheduled_at > :minScheduledAt', { minScheduledAt })
      .andWhere('(job.next_retry_at IS NULL OR job.next_retry_at <= :now)', {
        now,
      })
      .andWhere(
        `(job.status = 'pending' OR (job.status = 'failed' AND job.retry_count < job.max_retries))`,
      )
      .orderBy('job.remind_at', 'ASC')
      .limit(limit)
      .getMany();

    return rows.map((row) => this.mapEntity(row));
  }

  async claimJob(jobId: number): Promise<StudyReminderJob | null> {
    const result = await this.jobRepo.update(
      {
        id: jobId,
        status: In(['pending', 'failed']),
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
      lastError: null,
      nextRetryAt: null,
    });
  }

  async markFailed(params: {
    jobId: number;
    errorMessage: string;
    retryCount: number;
    nextRetryAt?: Date;
    terminal: boolean;
  }): Promise<void> {
    await this.jobRepo.update(params.jobId, {
      status: 'failed',
      retryCount: params.retryCount,
      lastError: params.errorMessage,
      nextRetryAt: params.terminal ? null : (params.nextRetryAt ?? null),
    });
  }

  async markCancelled(jobId: number, reason: string): Promise<void> {
    await this.jobRepo.update(jobId, {
      status: 'cancelled',
      lastError: reason,
      nextRetryAt: null,
    });
  }

  async deleteSentJobs(): Promise<number> {
    const result = await this.jobRepo
      .createQueryBuilder()
      .delete()
      .from(StudyReminderJobEntity)
      .where('status = :status', { status: 'sent' })
      .execute();

    return result.affected ?? 0;
  }

  async deleteTerminalJobsOlderThan(cutoff: Date): Promise<number> {
    const result = await this.jobRepo
      .createQueryBuilder()
      .delete()
      .from(StudyReminderJobEntity)
      .where(
        `(status = 'cancelled' AND updated_at < :cutoff)
         OR (status = 'failed' AND retry_count >= max_retries AND updated_at < :cutoff)`,
        { cutoff },
      )
      .execute();

    return result.affected ?? 0;
  }

  async resetStuckProcessingJobs(olderThan: Date): Promise<number> {
    const result = await this.jobRepo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set({ status: 'pending' })
      .where('status = :status', { status: 'processing' })
      .andWhere('updated_at <= :olderThan', { olderThan })
      .execute();

    return result.affected ?? 0;
  }

  async countJobsByStatus(): Promise<Record<string, number>> {
    const rows = await this.jobRepo
      .createQueryBuilder('job')
      .select('job.status', 'status')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy('job.status')
      .getRawMany<{ status: string; count: number }>();

    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  async countTerminalFailedSince(since: Date): Promise<number> {
    return this.jobRepo
      .createQueryBuilder('job')
      .where(`job.status = 'failed'`)
      .andWhere('job.retry_count >= job.max_retries')
      .andWhere('job.updated_at >= :since', { since })
      .getCount();
  }

  async findTerminalFailedSince(
    since: Date,
    limit: number,
  ): Promise<StudyReminderJob[]> {
    const entities = await this.jobRepo
      .createQueryBuilder('job')
      .where(`job.status = 'failed'`)
      .andWhere('job.retry_count >= job.max_retries')
      .andWhere('job.updated_at >= :since', { since })
      .orderBy('job.updated_at', 'DESC')
      .take(limit)
      .getMany();

    return entities.map((entity) => this.mapEntity(entity));
  }

  async findStuckProcessing(
    olderThan: Date,
    limit: number,
  ): Promise<StudyReminderJob[]> {
    const entities = await this.jobRepo
      .createQueryBuilder('job')
      .where(`job.status = 'processing'`)
      .andWhere('job.updated_at <= :olderThan', { olderThan })
      .orderBy('job.updated_at', 'ASC')
      .take(limit)
      .getMany();

    return entities.map((entity) => this.mapEntity(entity));
  }

  async findNextDueTime(after: Date): Promise<Date | null> {
    const rows = await this.jobRepo.manager.query<
      Array<{ next_due: Date | null }>
    >(
      `SELECT MIN(
         CASE
           WHEN next_retry_at IS NOT NULL AND next_retry_at > $1 THEN next_retry_at
           WHEN remind_at > $1 THEN remind_at
           ELSE NULL
         END
       ) AS next_due
       FROM study_reminder_jobs
       WHERE status IN ('pending', 'failed')`,
      [after],
    );
    return rows[0]?.next_due ?? null;
  }

  async countStuckProcessing(olderThan: Date): Promise<number> {
    return this.jobRepo
      .createQueryBuilder('job')
      .where(`job.status = 'processing'`)
      .andWhere('job.updated_at <= :olderThan', { olderThan })
      .getCount();
  }

  async cancelJobsFromOtherPlatforms(
    userId: number,
    currentPlatform: string,
  ): Promise<number> {
    if (!userId) {
      return 0;
    }

    const result = await this.jobRepo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set({ status: 'cancelled' })
      .where('user_id = :userId', { userId })
      .andWhere('platform != :currentPlatform', { currentPlatform })
      .andWhere('status IN (:...statuses)', {
        statuses: ['pending', 'failed', 'processing'],
      })
      .execute();

    return result.affected ?? 0;
  }

  private hasScheduleChanged(
    existing: StudyReminderJobEntity,
    input: UpsertStudyReminderJobInput,
  ): boolean {
    return (
      existing.scheduledAt.getTime() !== input.scheduledAt.getTime() ||
      existing.remindAt.getTime() !== input.remindAt.getTime() ||
      (input.topic ?? null) !== (existing.topic ?? null)
    );
  }

  private applyScheduleUpdate(
    existing: StudyReminderJobEntity,
    input: UpsertStudyReminderJobInput,
  ): void {
    existing.userId = input.userId ?? existing.userId;
    existing.scheduledAt = input.scheduledAt;
    existing.remindAt = input.remindAt;
    existing.topic = input.topic ?? existing.topic;
    existing.maxRetries = input.maxRetries;
  }

  private reopenToPending(
    existing: StudyReminderJobEntity,
    input: UpsertStudyReminderJobInput,
  ): void {
    this.applyScheduleUpdate(existing, input);
    existing.status = 'pending';
    existing.retryCount = 0;
    existing.sentAt = null;
    existing.lastError = null;
    existing.nextRetryAt = null;
  }

  private mapEntity(entity: StudyReminderJobEntity): StudyReminderJob {
    return {
      id: entity.id,
      platform: entity.platform,
      psid: entity.externalUserId,
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
