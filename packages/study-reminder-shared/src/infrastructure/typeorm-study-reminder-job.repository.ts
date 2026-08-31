import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { truncatePersistedError } from '@wispace/bot-common/masking';
import type {
  StudyReminderJobRepositoryPort,
  StudyReminderJob,
  StudyReminderJobStatus,
  UpsertStudyReminderJobInput,
  UpsertStudyReminderJobOptions,
} from '../ports/study-reminder-job.repository.port';
import type { SyncJobRepository } from '../ports/study-reminder-sync-job.repository.port';
import type { DispatchJobRepository } from '../ports/study-reminder-dispatch-job.repository.port';
import type { OpsJobRepository } from '../ports/study-reminder-ops-job.repository.port';
import { StudyReminderJobEntity } from '../entities/study-reminder-job.entity';
import type { Platform } from '@wispace/contracts';

const DEFAULT_STALE_CANCEL_STATUSES: StudyReminderJobStatus[] = [
  'pending',
  'failed',
];

/**
 * TypeORM implementation of StudyReminderJobRepositoryPort.
 * Also implements lifecycle-specific interfaces (SyncJobRepository,
 * DispatchJobRepository, OpsJobRepository) for focused dependency injection.
 * Shared across Discord, Zalo and Messenger.
 */
@Injectable()
export class TypeormStudyReminderJobRepository
  implements
    StudyReminderJobRepositoryPort,
    SyncJobRepository,
    DispatchJobRepository,
    OpsJobRepository
{
  private readonly logger = new Logger(TypeormStudyReminderJobRepository.name);

  constructor(
    @InjectRepository(StudyReminderJobEntity)
    private readonly repo: Repository<StudyReminderJobEntity>,
  ) {}

  async upsertPendingJob(
    input: UpsertStudyReminderJobInput,
    options?: UpsertStudyReminderJobOptions,
  ): Promise<StudyReminderJob> {
    if (!options?.lockKey) {
      return this.doUpsert(this.repo.manager, input, options);
    }

    // Serialize concurrent upserts for the same (platform, externalUserId, sessionKey).
    // pg_advisory_xact_lock is transaction-scoped — auto-released on commit/rollback.
    return this.repo.manager.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        options.lockKey,
      ]);
      return this.doUpsert(manager, input, options);
    });
  }

  async upsertPendingJobs(
    inputs: UpsertStudyReminderJobInput[],
    options?: UpsertStudyReminderJobOptions,
  ): Promise<StudyReminderJob[]> {
    if (inputs.length === 0) {
      return [];
    }

    const manager = this.repo.manager;
    const existingRows = await manager.findBy(
      StudyReminderJobEntity,
      inputs.map((input) => ({
        platform: input.platform,
        externalUserId: input.externalUserId,
        sessionKey: input.sessionKey,
      })),
    );
    const existingByKey = new Map(
      existingRows.map((row) => [this.entityKey(row), row]),
    );

    const toCreate: StudyReminderJobEntity[] = [];
    const toUpdate: StudyReminderJobEntity[] = [];
    for (const input of inputs) {
      const existing = existingByKey.get(this.inputKey(input));
      if (!existing) {
        toCreate.push(this.buildNewEntity(manager, input));
      } else {
        this.applyExisting(existing, input, options);
        toUpdate.push(existing);
      }
    }

    const saved: StudyReminderJobEntity[] = [];
    if (toCreate.length > 0) {
      saved.push(...(await manager.save(StudyReminderJobEntity, toCreate)));
    }
    if (toUpdate.length > 0) {
      saved.push(...(await manager.save(StudyReminderJobEntity, toUpdate)));
    }
    return saved.map((entity) => this.mapEntity(entity));
  }

  private async doUpsert(
    manager: EntityManager,
    input: UpsertStudyReminderJobInput,
    options?: UpsertStudyReminderJobOptions,
  ): Promise<StudyReminderJob> {
    const existing = await manager.findOne(StudyReminderJobEntity, {
      where: {
        platform: input.platform,
        externalUserId: input.externalUserId,
        sessionKey: input.sessionKey,
      },
    });

    if (!existing) {
      const saved = await manager.save(
        StudyReminderJobEntity,
        this.buildNewEntity(manager, input),
      );
      return this.mapEntity(saved);
    }

    this.applyExisting(existing, input, options);
    const saved = await manager.save(StudyReminderJobEntity, existing);
    return this.mapEntity(saved);
  }

  private buildNewEntity(
    manager: EntityManager,
    input: UpsertStudyReminderJobInput,
  ): StudyReminderJobEntity {
    return manager.create(StudyReminderJobEntity, {
      platform: input.platform,
      externalUserId: input.externalUserId,
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
  }

  private applyExisting(
    existing: StudyReminderJobEntity,
    input: UpsertStudyReminderJobInput,
    options?: UpsertStudyReminderJobOptions,
  ): void {
    const reopenOnlyOnScheduleChange =
      options?.reopenOnlyOnScheduleChange ?? false;

    if (existing.status === 'sent') {
      if (
        !reopenOnlyOnScheduleChange ||
        !this.hasScheduleChanged(existing, input)
      ) {
        return;
      }
      this.reopenToPending(existing, input);
      return;
    }

    if (existing.status === 'processing') {
      if (
        reopenOnlyOnScheduleChange &&
        !this.hasScheduleChanged(existing, input)
      ) {
        return;
      }
      this.reopenToPending(existing, input);
      return;
    }

    if (existing.status === 'cancelled') {
      this.reopenToPending(existing, input);
      return;
    }

    // pending / failed — update in place
    existing.userId = input.userId ?? existing.userId;
    existing.scheduledAt = input.scheduledAt;
    existing.remindAt = input.remindAt;
    existing.topic = input.topic ?? existing.topic;
    existing.maxRetries = input.maxRetries;
    if (reopenOnlyOnScheduleChange) {
      // Messenger keeps retryCount across re-syncs; failed jobs re-enter as pending.
      if (existing.status === 'failed') {
        existing.status = 'pending';
        existing.nextRetryAt = null;
        existing.lastError = null;
      }
    } else {
      existing.status = 'pending';
      existing.retryCount = 0;
      existing.lastError = null;
      existing.nextRetryAt = null;
    }
  }

  private inputKey(input: UpsertStudyReminderJobInput): string {
    return `${input.platform}|${input.externalUserId}|${input.sessionKey}`;
  }

  private entityKey(entity: StudyReminderJobEntity): string {
    return `${entity.platform}|${entity.externalUserId}|${entity.sessionKey}`;
  }

  async findDueJobs(
    platform: Platform,
    now: Date,
    minLeadMinutes: number,
  ): Promise<StudyReminderJob[]> {
    const minLeadAt = new Date(now.getTime() + minLeadMinutes * 60 * 1000);
    const rows = await this.repo
      .createQueryBuilder('job')
      .where('job.status IN (:...statuses)', {
        statuses: ['pending', 'failed'],
      })
      .andWhere('job.platform = :platform', { platform })
      .andWhere('job.remind_at <= :now', { now })
      .andWhere('job.scheduled_at > :minLeadAt', { minLeadAt })
      .andWhere('(job.next_retry_at IS NULL OR job.next_retry_at <= :now)', {
        now,
      })
      .andWhere(
        `(job.status = 'pending' OR (job.status = 'failed' AND job.retry_count < job.max_retries))`,
      )
      .orderBy('job.remind_at', 'ASC')
      .limit(50)
      .getMany();
    return rows.map((r) => this.mapEntity(r));
  }

  async claimJob(
    platform: Platform,
    jobId: number,
    leaseMs: number,
  ): Promise<StudyReminderJob | null> {
    // Assign a fresh lease token + expiry so recovery (which reopens only
    // expired leases) and stale owners (whose token no longer matches) can
    // never double-send or overwrite a newer owner's result. The claim is
    // scoped to the worker's platform (#180).
    const rows: Array<Record<string, unknown>> = await this.repo.query(
      `UPDATE study_reminder_jobs
       SET status = 'processing',
           lease_token = gen_random_uuid(),
           lease_expires_at = now() + ($2::int * interval '1 millisecond')
       WHERE id = $1 AND platform = $3 AND status IN ('pending', 'failed')
       RETURNING *`,
      [jobId, leaseMs, platform],
    );
    if (!rows.length) return null;
    return this.mapEntity(rows[0] as unknown as StudyReminderJobEntity);
  }

  async markSent(
    jobId: number,
    leaseToken: string,
    deliveryRecord?: string,
    deliveryKey?: string,
  ): Promise<void> {
    const result = await this.repo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set({
        status: 'sent',
        sentAt: new Date(),
        nextRetryAt: null,
        lastError: null,
        ...(deliveryRecord !== undefined ? { deliveryRecord } : {}),
        ...(deliveryKey !== undefined ? { deliveryKey } : {}),
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

  async markDeliveryKey(jobId: number, deliveryKey: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set({ deliveryKey })
      .where('id = :id', { id: jobId })
      .execute();
  }

  async markFailed(params: {
    jobId: number;
    leaseToken: string;
    errorMessage: string;
    retryCount: number;
    nextRetryAt?: Date;
    terminal: boolean;
  }): Promise<void> {
    const result = await this.repo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set({
        status: 'failed',
        retryCount: params.retryCount,
        lastError: truncatePersistedError(params.errorMessage),
        nextRetryAt: params.terminal ? null : (params.nextRetryAt ?? null),
      })
      .where('id = :id', { id: params.jobId })
      .andWhere('lease_token = :leaseToken', { leaseToken: params.leaseToken })
      .execute();
    if (!result.affected) {
      this.logger.warn(
        `markFailed ignored for jobId=${params.jobId}: lease token mismatch (stale owner)`,
      );
    }
  }

  async markCancelled(
    jobId: number,
    leaseToken: string,
    reason?: string,
  ): Promise<void> {
    const patch: Partial<StudyReminderJobEntity> = { status: 'cancelled' };
    if (reason) {
      patch.lastError = truncatePersistedError(reason);
      patch.nextRetryAt = null;
    }
    const result = await this.repo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set(patch)
      .where('id = :id', { id: jobId })
      .andWhere('lease_token = :leaseToken', { leaseToken })
      .execute();
    if (!result.affected) {
      this.logger.warn(
        `markCancelled ignored for jobId=${jobId}: lease token mismatch (stale owner)`,
      );
    }
  }

  async cancelStaleJobsForExternalUserId(
    platform: string,
    externalUserId: string,
    activeSessionKeys: string[],
    horizonEnd?: Date,
    options?: { statuses?: StudyReminderJobStatus[] },
  ): Promise<number> {
    const qb = this.repo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set({ status: 'cancelled' })
      .where('platform = :platform', { platform })
      .andWhere('externalUserId = :externalUserId', { externalUserId })
      .andWhere('status IN (:...statuses)', {
        statuses: options?.statuses ?? DEFAULT_STALE_CANCEL_STATUSES,
      });
    if (activeSessionKeys.length > 0) {
      qb.andWhere('sessionKey NOT IN (:...keys)', { keys: activeSessionKeys });
    }
    if (horizonEnd) {
      qb.andWhere('scheduled_at <= :horizonEnd', { horizonEnd });
    }
    const result = await qb.execute();
    return result.affected ?? 0;
  }

  async cancelPendingJobsForExternalUser(
    platform: Platform,
    externalUserId: string,
    reason = 'reminder_opted_out',
  ): Promise<number> {
    // Same status trio + lease clearing as privacy unlink: an in-flight send
    // completes, but nothing retries or fires afterwards.
    const result = await this.repo.manager.query<{ rowCount: number }>(
      `UPDATE study_reminder_jobs
       SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL,
           last_error = $3, updated_at = now()
       WHERE platform = $1 AND external_user_id = $2
         AND status IN ('pending', 'processing', 'failed')`,
      [platform, externalUserId, truncatePersistedError(reason)],
    );
    return result?.rowCount ?? 0;
  }

  async cancelJobsFromOtherPlatforms(
    userId: number,
    currentPlatform: string,
    options?: { statuses?: StudyReminderJobStatus[] },
  ): Promise<number> {
    if (!userId) {
      return 0;
    }
    const result = await this.repo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set({ status: 'cancelled' })
      .where('userId = :userId', { userId })
      .andWhere('platform != :platform', { platform: currentPlatform })
      .andWhere('status IN (:...statuses)', {
        statuses: options?.statuses ?? DEFAULT_STALE_CANCEL_STATUSES,
      })
      .execute();
    return result.affected ?? 0;
  }

  async findNextDueTime(now: Date, platform?: Platform): Promise<Date | null> {
    // Earliest moment any pending/retryable job becomes actionable — accounts
    // for next_retry_at (Messenger semantics; shared by all platforms).
    // Optional platform filter avoids cross-platform full-table scan (#265).
    const conditions = ["status IN ('pending', 'failed')"];
    const params: unknown[] = [now];
    if (platform) {
      conditions.push('platform = $2');
      params.push(platform);
    }
    const rows = await this.repo.manager.query<
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
       WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return rows[0]?.next_due ?? null;
  }

  async resetStuckProcessingJobs(
    platform: Platform,
    olderThan: Date,
    targetStatus: 'pending' | 'failed' = 'failed',
  ): Promise<number> {
    // Reopen only processing rows whose LEASE expired (live lease = worker
    // still active) or legacy rows (no lease) past the updated_at threshold.
    // Scoped to the worker's platform — never reset another bot's jobs (#180).
    // Stuck processing → ambiguous: the provider may have accepted the message,
    // so a blind resend risks a duplicate (#294).
    const result = await this.repo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set({
        status: targetStatus,
        deliveryStatus: 'ambiguous',
      })
      .where('status = :status', { status: 'processing' })
      .andWhere('platform = :platform', { platform })
      .andWhere(
        '(lease_expires_at < :now OR (lease_expires_at IS NULL AND updated_at <= :olderThan))',
        { now: new Date(), olderThan },
      )
      .execute();
    return result.affected ?? 0;
  }

  async deleteSentJobs(olderThan?: Date): Promise<number> {
    const qb = this.repo
      .createQueryBuilder()
      .delete()
      .where('status = :status', { status: 'sent' });
    if (olderThan) {
      qb.andWhere('sent_at < :olderThan', { olderThan });
    }
    const result = await qb.execute();
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

  async countJobsByStatus(platform?: string): Promise<Record<string, number>> {
    const qb = this.repo
      .createQueryBuilder('job')
      .select('job.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('job.status');
    if (platform) {
      qb.where('job.platform = :platform', { platform });
    }
    const rows = await qb.getRawMany<{ status: string; count: string }>();
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

  async countStuckProcessing(olderThan: Date): Promise<number> {
    return this.repo
      .createQueryBuilder('job')
      .where('job.status = :status', { status: 'processing' })
      .andWhere('job.updated_at <= :olderThan', { olderThan })
      .getCount();
  }

  async findTerminalFailedSince(
    since: Date,
    limit: number,
  ): Promise<StudyReminderJob[]> {
    const entities = await this.repo
      .createQueryBuilder('job')
      .where('job.status = :status', { status: 'failed' })
      .andWhere('job.retry_count >= job.max_retries')
      .andWhere('job.updated_at >= :since', { since })
      .orderBy('job.updated_at', 'DESC')
      .take(limit)
      .getMany();
    return entities.map((r) => this.mapEntity(r));
  }

  async findStuckProcessing(
    olderThan: Date,
    limit?: number,
  ): Promise<StudyReminderJob[]> {
    const qb = this.repo
      .createQueryBuilder('job')
      .where('job.status = :status', { status: 'processing' })
      .andWhere('job.updated_at <= :olderThan', { olderThan })
      .orderBy('job.updated_at', 'ASC');
    if (limit) {
      qb.limit(limit);
    }
    const rows = await qb.getMany();
    return rows.map((r) => this.mapEntity(r));
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

  private reopenToPending(
    existing: StudyReminderJobEntity,
    input: UpsertStudyReminderJobInput,
  ): void {
    existing.userId = input.userId ?? existing.userId;
    existing.scheduledAt = input.scheduledAt;
    existing.remindAt = input.remindAt;
    existing.topic = input.topic ?? existing.topic;
    existing.maxRetries = input.maxRetries;
    existing.status = 'pending';
    existing.retryCount = 0;
    existing.sentAt = null;
    existing.lastError = null;
    existing.nextRetryAt = null;
  }

  private mapEntity(entity: StudyReminderJobEntity): StudyReminderJob {
    // Raw query rows (claimJob RETURNING *) arrive with snake_case keys;
    // entity rows carry camelCase properties — read both.
    const row = entity as StudyReminderJobEntity & Record<string, unknown>;
    return {
      id: row.id,
      platform: row.platform,
      externalUserId: row.externalUserId ?? row.external_user_id,
      userId:
        row.userId ?? (row.user_id as number | null | undefined) ?? undefined,
      sessionKey: row.sessionKey ?? row.session_key,
      scheduledAt: row.scheduledAt ?? row.scheduled_at,
      remindAt: row.remindAt ?? row.remind_at,
      topic: row.topic ?? undefined,
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
      deliveryRecord: (row.deliveryRecord ??
        row.delivery_record ??
        undefined) as string | undefined,
      createdAt: row.createdAt ?? row.created_at,
      updatedAt: row.updatedAt ?? row.updated_at,
    };
  }
}
