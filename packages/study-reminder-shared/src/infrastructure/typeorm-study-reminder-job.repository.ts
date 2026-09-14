import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  hashExternalId,
  truncatePersistedError,
} from '@wispace/bot-common/masking';
import { extractQueryRows } from '@wispace/bot-common/utils';
import type {
  StudyReminderJobRepositoryPort,
  StudyReminderJob,
  StudyReminderJobStatus,
  UpsertStudyReminderJobInput,
  UpsertStudyReminderJobOptions,
  OwnedDeliveryParams,
  OwnedDeliveryResult,
} from '../ports/study-reminder-job.repository.port';
import type { SyncJobRepository } from '../ports/study-reminder-sync-job.repository.port';
import type { DispatchJobRepository } from '../ports/study-reminder-dispatch-job.repository.port';
import type { OpsJobRepository } from '../ports/study-reminder-ops-job.repository.port';
import { StudyReminderJobEntity } from '../entities/study-reminder-job.entity';
import type { OutboundDeliveryOutcome, Platform } from '@wispace/contracts';
import {
  acquireStudyReminderOwnershipLock,
  studyReminderMappingTable,
} from './study-reminder-ownership';
import {
  studyReminderDispatchPredicateSql,
  studyReminderTerminalFailurePredicateSql,
  studyReminderTerminalRetentionPredicateSql,
} from '../utils/job-predicates';

const DEFAULT_STALE_CANCEL_STATUSES: StudyReminderJobStatus[] = [
  'pending',
  'failed',
];

const TERMINAL_DELIVERY_OUTCOMES: OutboundDeliveryOutcome[] = [
  'sent',
  'ambiguous',
  'rate_limited',
];

function isTerminalDeliveryOutcome(
  outcome: OutboundDeliveryOutcome | null | undefined,
): boolean {
  return outcome != null && TERMINAL_DELIVERY_OUTCOMES.includes(outcome);
}

function isTerminalStoredFailure(entity: StudyReminderJobEntity): boolean {
  return (
    isTerminalDeliveryOutcome(entity.deliveryStatus) ||
    (entity.deliveryStatus === 'not_sent' &&
      entity.retryCount >= entity.maxRetries)
  );
}

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

  async upsertPendingJobs(
    inputs: UpsertStudyReminderJobInput[],
    options?: UpsertStudyReminderJobOptions,
  ): Promise<StudyReminderJob[]> {
    if (inputs.length === 0) {
      return [];
    }

    return this.repo.manager.transaction(async (manager) => {
      await this.acquireUpsertLocks(manager, inputs);

      // Lock rows before reading them. This prevents a sync snapshot from
      // overwriting a concurrent claim or cancellation after its SELECT.
      const existingRows = await this.lockedExistingRows(manager, inputs);
      const existingByKey = new Map(
        existingRows.map((row) => [this.entityKey(row), row]),
      );

      const saved: StudyReminderJobEntity[] = [];
      for (const input of inputs) {
        const existing = existingByKey.get(this.inputKey(input));
        if (!existing) {
          saved.push(
            await manager.save(
              StudyReminderJobEntity,
              this.buildNewEntity(manager, input),
            ),
          );
          continue;
        }

        this.applyExisting(existing, input, options);
        saved.push(await manager.save(StudyReminderJobEntity, existing));
      }

      return saved.map((entity) => this.mapEntity(entity));
    });
  }

  private async acquireUpsertLocks(
    manager: EntityManager,
    inputs: UpsertStudyReminderJobInput[],
  ): Promise<void> {
    const lockKeys = new Set(
      [...inputs]
        .sort((a, b) => this.inputKey(a).localeCompare(this.inputKey(b)))
        .map((input) => this.inputKey(input)),
    );
    for (const lockKey of lockKeys) {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        lockKey,
      ]);
    }
  }

  private async lockedExistingRows(
    manager: EntityManager,
    inputs: UpsertStudyReminderJobInput[],
  ): Promise<StudyReminderJobEntity[]> {
    const sorted = [...inputs].sort((a, b) =>
      this.inputKey(a).localeCompare(this.inputKey(b)),
    );
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const input of sorted) {
      const offset = params.length + 1;
      clauses.push(
        `(platform = $${offset} AND external_user_id = $${offset + 1} AND session_key = $${offset + 2})`,
      );
      params.push(input.platform, input.externalUserId, input.sessionKey);
    }
    await manager.query(
      `SELECT id FROM study_reminder_jobs
       WHERE ${clauses.join(' OR ')}
       FOR UPDATE`,
      params,
    );
    return manager.findBy(
      StudyReminderJobEntity,
      inputs.map((input) => ({
        platform: input.platform,
        externalUserId: input.externalUserId,
        sessionKey: input.sessionKey,
      })),
    );
  }

  private buildNewEntity(
    manager: EntityManager,
    input: UpsertStudyReminderJobInput,
  ): StudyReminderJobEntity {
    return manager.create(StudyReminderJobEntity, {
      platform: input.platform,
      externalUserId: input.externalUserId,
      userId: input.userId ?? null,
      mappingGeneration: input.mappingGeneration,
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
      leaseToken: null,
      leaseExpiresAt: null,
      deliveryRecord: null,
      deliveryKey: null,
      deliveryStatus: null,
      processingStartedAt: null,
    });
  }

  private applyExisting(
    existing: StudyReminderJobEntity,
    input: UpsertStudyReminderJobInput,
    options?: UpsertStudyReminderJobOptions,
  ): void {
    const reopenOnlyOnScheduleChange =
      options?.reopenOnlyOnScheduleChange ?? false;
    const scheduleChanged = this.hasScheduleChanged(existing, input);
    if (
      this.isOlderGeneration(
        existing.mappingGeneration,
        input.mappingGeneration,
      )
    ) {
      return;
    }
    const ownerChanged =
      (input.mappingGeneration !== undefined &&
        existing.mappingGeneration !== input.mappingGeneration) ||
      (input.userId !== undefined && existing.userId !== input.userId);

    if (existing.status === 'sent') {
      if (!scheduleChanged) {
        return;
      }
      this.reopenToPending(existing, input);
      return;
    }

    if (existing.status === 'processing') {
      // Never rewrite an in-flight job's owner while a sender may still hold
      // the claim. The delivery fence will cancel it against the new mapping.
      if (ownerChanged) {
        return;
      }
      if (reopenOnlyOnScheduleChange && !scheduleChanged) {
        return;
      }
      this.reopenToPending(existing, input);
      return;
    }

    if (existing.status === 'cancelled') {
      this.reopenToPending(existing, input);
      return;
    }

    // Any schedule mutation is a new delivery generation, including pending
    // and failed rows. Clear the previous attempt before the next claim.
    if (scheduleChanged) {
      this.reopenToPending(existing, input);
      return;
    }

    // Ambiguous/rate-limited/sent are terminal outcomes. A periodic sync must
    // not turn one into a fresh due attempt unless the schedule is a new
    // generation (handled above by reopenToPending).
    if (isTerminalStoredFailure(existing)) {
      existing.userId = input.userId ?? existing.userId;
      existing.maxRetries = input.maxRetries;
      if (existing.deliveryStatus === 'not_sent') {
        existing.status = 'failed';
      }
      return;
    }

    // pending / failed — update in place
    existing.userId = input.userId ?? existing.userId;
    if (input.mappingGeneration !== undefined) {
      existing.mappingGeneration = input.mappingGeneration;
    }
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

  private isOlderGeneration(
    existingGeneration: string | null | undefined,
    incomingGeneration: string | undefined,
  ): boolean {
    if (!existingGeneration || incomingGeneration === undefined) return false;
    try {
      return BigInt(incomingGeneration) < BigInt(existingGeneration);
    } catch {
      // Invalid generations are never allowed to overwrite a known value.
      return true;
    }
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
      .where(studyReminderDispatchPredicateSql('job'))
      .andWhere('job.platform = :platform', { platform })
      .andWhere('job.remind_at <= :now', { now })
      .andWhere('job.scheduled_at > :minLeadAt', { minLeadAt })
      .andWhere('(job.next_retry_at IS NULL OR job.next_retry_at <= :now)', {
        now,
      })
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
    const rows = extractQueryRows<Record<string, unknown>>(
      await this.repo.query(
        `UPDATE study_reminder_jobs
       SET status = 'processing',
           lease_token = gen_random_uuid(),
           lease_expires_at = now() + ($2::int * interval '1 millisecond'),
           processing_started_at = now(),
           delivery_status = NULL
       WHERE id = $1 AND platform = $3
         AND ${studyReminderDispatchPredicateSql()}
       RETURNING *`,
        [jobId, leaseMs, platform],
      ),
    );
    if (!rows.length) return null;
    return this.mapEntity(rows[0] as unknown as StudyReminderJobEntity);
  }

  async markSent(
    jobId: number,
    leaseToken: string,
    deliveryRecord?: string,
    deliveryKey?: string,
  ): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set({
        status: 'sent',
        sentAt: new Date(),
        nextRetryAt: null,
        lastError: null,
        deliveryStatus: 'sent',
        leaseToken: null,
        leaseExpiresAt: null,
        processingStartedAt: null,
        ...(deliveryRecord !== undefined ? { deliveryRecord } : {}),
        ...(deliveryKey !== undefined ? { deliveryKey } : {}),
      })
      .where('id = :id', { id: jobId })
      .andWhere('lease_token = :leaseToken', { leaseToken })
      .andWhere("status = 'processing'")
      .execute();
    if (!result.affected) {
      this.logger.warn(
        `markSent ignored for jobId=${jobId}: lease token mismatch (stale owner)`,
      );
      return false;
    }
    return true;
  }

  async markDeliveryKey(
    jobId: number,
    leaseToken: string,
    deliveryKey: string,
  ): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set({ deliveryKey })
      .where('id = :id', { id: jobId })
      .andWhere('lease_token = :leaseToken', { leaseToken })
      .andWhere("status = 'processing'")
      .execute();
    if (!result.affected) {
      this.logger.warn(
        `markDeliveryKey ignored for jobId=${jobId}: lease token mismatch (stale owner)`,
      );
      return false;
    }
    return true;
  }

  async withOwnedDelivery<T>(
    params: OwnedDeliveryParams,
    send: () => Promise<T>,
  ): Promise<OwnedDeliveryResult<T>> {
    try {
      return await this.repo.manager.transaction(async (manager) => {
        const timeoutMs = Math.max(
          1,
          Math.min(Math.trunc(params.lockTimeoutMs ?? 5_000), 10_000),
        );
        await manager.query(`SET LOCAL lock_timeout = '${timeoutMs}ms'`);
        await acquireStudyReminderOwnershipLock(
          manager,
          params.platform,
          params.externalUserId,
        );

        const table = studyReminderMappingTable(params.platform);
        const statusSelect = params.platform === 'messenger' ? ', status' : '';
        const rows = extractQueryRows<{
          userId: number | null;
          state: string;
          mappingGeneration: string | null;
          status?: string;
        }>(
          await manager.query(
            `SELECT user_id AS "userId",
                    COALESCE(link_state, 'active') AS state,
                    mapping_generation AS "mappingGeneration"${statusSelect}
             FROM "${table}"
             WHERE platform = $1 AND external_user_id = $2
             ORDER BY id DESC LIMIT 1
             FOR UPDATE`,
            [params.platform, params.externalUserId],
          ),
        );
        const mapping = rows[0];
        if (!mapping) {
          const tombstone = extractQueryRows<{ exists: boolean }>(
            await manager.query(
              `SELECT EXISTS (
                 SELECT 1 FROM platform_link_audit_events
                 WHERE platform = $1 AND external_user_hash = $2
                   AND event_type = 'locally_unlinked'
               ) AS exists`,
              [params.platform, hashExternalId(params.externalUserId)],
            ),
          )[0]?.exists;
          return {
            authorized: false,
            reason: tombstone ? 'locally_unlinked' : 'link_status_unknown',
          };
        }
        if (params.platform === 'messenger' && mapping.status !== 'ACTIVE') {
          return { authorized: false, reason: 'locally_unlinked' };
        }
        if (mapping.state === 'confirmed-revoked') {
          return { authorized: false, reason: 'link_revoked' };
        }
        if (mapping.state === 'locally-unlinked') {
          return { authorized: false, reason: 'locally_unlinked' };
        }
        if (mapping.state !== 'active') {
          return { authorized: false, reason: 'link_status_unknown' };
        }
        if (!mapping.mappingGeneration) {
          return { authorized: false, reason: 'mapping_generation_missing' };
        }
        if (
          Number(mapping.userId) !== params.userId ||
          String(mapping.mappingGeneration) !== params.mappingGeneration
        ) {
          return { authorized: false, reason: 'mapping_ownership_changed' };
        }

        const deliveryRows = extractQueryRows<{ id: number }>(
          await manager.query(
            `UPDATE study_reminder_jobs
             SET delivery_key = COALESCE(delivery_key, $3), updated_at = now()
             WHERE id = $1 AND platform = $2
               AND lease_token = $4 AND status = 'processing'
             RETURNING id`,
            [
              params.jobId,
              params.platform,
              params.deliveryKey,
              params.leaseToken,
            ],
          ),
        );
        if (deliveryRows.length === 0) {
          return { authorized: false, reason: 'lease_lost' };
        }

        return { authorized: true, value: await send() };
      });
    } catch (error) {
      if ((error as { code?: string })?.code === '55P03') {
        return { authorized: false, reason: 'ownership_lock_timeout' };
      }
      throw error;
    }
  }

  async markFailed(params: {
    jobId: number;
    leaseToken: string;
    errorMessage: string;
    retryCount: number;
    nextRetryAt?: Date;
    terminal: boolean;
    deliveryStatus: OutboundDeliveryOutcome;
  }): Promise<void> {
    const result = await this.repo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set({
        status: 'failed',
        retryCount: params.retryCount,
        lastError: truncatePersistedError(params.errorMessage),
        nextRetryAt: params.terminal ? null : (params.nextRetryAt ?? null),
        deliveryStatus: params.deliveryStatus,
        leaseToken: null,
        leaseExpiresAt: null,
        processingStartedAt: null,
      })
      .where('id = :id', { id: params.jobId })
      .andWhere('lease_token = :leaseToken', { leaseToken: params.leaseToken })
      .andWhere("status = 'processing'")
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
    const patch: Partial<StudyReminderJobEntity> = {
      status: 'cancelled',
      nextRetryAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      processingStartedAt: null,
      deliveryRecord: null,
      deliveryKey: null,
      deliveryStatus: null,
    };
    if (reason) {
      patch.lastError = truncatePersistedError(reason);
    }
    const result = await this.repo
      .createQueryBuilder()
      .update(StudyReminderJobEntity)
      .set(patch)
      .where('id = :id', { id: jobId })
      .andWhere('lease_token = :leaseToken', { leaseToken })
      .andWhere("status = 'processing'")
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
      .set({
        status: 'cancelled',
        nextRetryAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        processingStartedAt: null,
        deliveryRecord: null,
        deliveryKey: null,
        deliveryStatus: null,
      })
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
           processing_started_at = NULL, delivery_record = NULL,
           delivery_key = NULL, delivery_status = NULL, next_retry_at = NULL,
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
      .set({
        status: 'cancelled',
        nextRetryAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        processingStartedAt: null,
        deliveryRecord: null,
        deliveryKey: null,
        deliveryStatus: null,
      })
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
    const conditions = [studyReminderDispatchPredicateSql()];
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
        nextRetryAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        processingStartedAt: null,
      })
      .where('status = :status', { status: 'processing' })
      .andWhere('platform = :platform', { platform })
      .andWhere(
        '(lease_expires_at < :now OR (lease_expires_at IS NULL AND COALESCE(processing_started_at, updated_at) <= :olderThan))',
        { now: new Date(), olderThan },
      )
      .execute();
    return result.affected ?? 0;
  }

  async deleteSentJobs(platform: Platform, olderThan?: Date): Promise<number> {
    const qb = this.repo
      .createQueryBuilder()
      .delete()
      .where('status = :status', { status: 'sent' })
      // Retention is per-platform on the shared table — an unscoped delete
      // would purge other bots' sent rows and resurrect them as new pending
      // jobs with fresh delivery keys (#443, scope family #180).
      .andWhere('platform = :platform', { platform });
    if (olderThan) {
      qb.andWhere('sent_at < :olderThan', { olderThan });
    }
    const result = await qb.execute();
    return result.affected ?? 0;
  }

  async deleteTerminalJobsOlderThan(
    platform: Platform,
    olderThan: Date,
  ): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .where(studyReminderTerminalRetentionPredicateSql())
      .andWhere('updated_at < :olderThan', { olderThan })
      // Same per-platform scoping as deleteSentJobs (#443).
      .andWhere('platform = :platform', { platform })
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
      .where(studyReminderTerminalFailurePredicateSql('job'))
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
      .where(studyReminderTerminalFailurePredicateSql('job'))
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
    if (input.mappingGeneration !== undefined) {
      existing.mappingGeneration = input.mappingGeneration;
    }
    existing.scheduledAt = input.scheduledAt;
    existing.remindAt = input.remindAt;
    existing.topic = input.topic ?? existing.topic;
    existing.maxRetries = input.maxRetries;
    existing.status = 'pending';
    existing.retryCount = 0;
    existing.sentAt = null;
    existing.lastError = null;
    existing.nextRetryAt = null;
    existing.leaseToken = null;
    existing.leaseExpiresAt = null;
    existing.deliveryRecord = null;
    existing.deliveryKey = null;
    existing.deliveryStatus = null;
    existing.processingStartedAt = null;
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
      mappingGeneration: (row.mappingGeneration ??
        row.mapping_generation ??
        undefined) as string | undefined,
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
      deliveryKey: (row.deliveryKey ?? row.delivery_key ?? undefined) as
        | string
        | undefined,
      deliveryStatus: (row.deliveryStatus ??
        row.delivery_status ??
        undefined) as OutboundDeliveryOutcome | undefined,
      processingStartedAt: (row.processingStartedAt ??
        row.processing_started_at ??
        undefined) as Date | undefined,
      createdAt: row.createdAt ?? row.created_at,
      updatedAt: row.updatedAt ?? row.updated_at,
    };
  }
}
