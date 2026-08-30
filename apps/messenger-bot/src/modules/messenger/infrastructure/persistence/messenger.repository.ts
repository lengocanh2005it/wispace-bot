import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import {
  buildPocPsidToken,
  DEFAULT_TOPIC,
} from '@messenger/shared/config/poc.constants';
import {
  MessageLogEntity,
  ScheduledReportClaimEntity,
  UserPlatformMappingEntity,
} from '@messenger/infrastructure/database/entities';
import { listUserIdsWithSentReport } from '@wispace/database';
import { MessengerRepositoryPort } from '../../domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '../../domain/repositories/messenger-mapping.repository.port';
import type { MessengerMessageLogRepositoryPort } from '../../domain/repositories/messenger-message-log.repository.port';
import type { ReportClaimRepositoryPort } from '@wispace/scheduler-core';
import type {
  OutboundDeliveryOutcome,
  PlatformLinkState,
} from '@wispace/contracts';
import {
  MessengerMessageLog,
  NotificationCadence,
  UserMessengerMapping,
} from '../../domain/entities/messenger.types';

/** This repository only ever writes rows for the Messenger bot. */
const PLATFORM = 'messenger' as const;

@Injectable()
export class MessengerRepository
  implements
    MessengerMappingRepositoryPort,
    MessengerMessageLogRepositoryPort,
    ReportClaimRepositoryPort,
    MessengerRepositoryPort
{
  constructor(
    @InjectRepository(UserPlatformMappingEntity)
    private readonly mappingRepo: Repository<UserPlatformMappingEntity>,
    @InjectRepository(MessageLogEntity)
    private readonly logRepo: Repository<MessageLogEntity>,
    @InjectRepository(ScheduledReportClaimEntity)
    private readonly reportClaimRepo: Repository<ScheduledReportClaimEntity>,
  ) {}

  async findActiveMappingByPsid(
    psid: string,
  ): Promise<UserMessengerMapping | null> {
    const row = await this.mappingRepo.findOne({
      where: { platform: PLATFORM, externalUserId: psid, status: 'ACTIVE' },
    });

    return row && this.isUsableLink(row) ? this.mapEntity(row) : null;
  }

  async findMappingStateByPsid(
    psid: string,
  ): Promise<PlatformLinkState | null> {
    const row = await this.mappingRepo.findOne({
      where: { platform: PLATFORM, externalUserId: psid },
      select: { linkState: true },
    });
    return row?.linkState ?? (row ? 'active' : null);
  }

  async findActiveMappingByUserId(
    userId: number,
  ): Promise<UserMessengerMapping | null> {
    const row = await this.mappingRepo.findOne({
      where: { platform: PLATFORM, userId, status: 'ACTIVE' },
      order: { id: 'DESC' },
    });

    if (!row?.externalUserId || !this.isUsableLink(row)) {
      return null;
    }

    return this.mapEntity(row);
  }

  async upsertPsidUserLink(params: {
    psid: string;
    userId: number;
    topic?: string;
    cadence?: NotificationCadence;
    expectedGeneration?: string;
  }): Promise<UserMessengerMapping | null> {
    const token = buildPocPsidToken(params.psid);

    // 1. Re-activate a previously deactivated mapping (keeps its id) — the
    //    INSERT below can only conflict with ACTIVE rows, so an INACTIVE row
    //    would otherwise be left behind while a duplicate ACTIVE row is created.
    const reactivatedRows: Array<Record<string, unknown>> =
      await this.mappingRepo.manager.query(
        `
      UPDATE user_platform_mappings
      SET
        user_id = $3,
        notification_messages_token = COALESCE(notification_messages_token, $4),
        topic = COALESCE($5, topic),
        cadence = COALESCE($6, cadence),
        status = 'ACTIVE',
        link_state = 'active',
        mapping_generation = CASE WHEN link_state <> 'active' THEN mapping_generation + 1 ELSE mapping_generation END,
        revoked_at = NULL,
        revocation_reason = NULL,
        updated_at = now()
      WHERE platform = $1
        AND external_user_id = $2
        AND status = 'INACTIVE'
        AND mapping_generation = COALESCE($7::bigint, mapping_generation)
      RETURNING id
    `,
        [
          PLATFORM,
          params.psid,
          params.userId,
          token,
          params.topic ?? null,
          params.cadence ?? null,
          params.expectedGeneration ?? null,
        ],
      );

    if (
      params.expectedGeneration !== undefined &&
      reactivatedRows.length === 0
    ) {
      const existingRows: Array<Record<string, unknown>> =
        await this.mappingRepo.manager.query(
          `SELECT id, mapping_generation FROM user_platform_mappings
           WHERE platform = $1 AND external_user_id = $2`,
          [PLATFORM, params.psid],
        );
      if (
        existingRows.length > 0 &&
        String(existingRows[0].mapping_generation ?? '1') !==
          params.expectedGeneration
      ) {
        return null;
      }
    }

    // 2. Atomic upsert against the partial unique index
    //    (platform, external_user_id WHERE status='ACTIVE'): concurrent link
    //    events (opt-ins have no mid, so dedupe never filters them) can no
    //    longer race findOne→save into a unique-violation 500. The conflict
    //    target must match the index columns exactly or Postgres raises 42P10.
    const rows: Array<Record<string, unknown>> =
      await this.mappingRepo.manager.query(
        `
        INSERT INTO user_platform_mappings
          (platform, external_user_id, user_id, notification_messages_token, topic, cadence, status, link_state)
        VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', 'active')
        ON CONFLICT (platform, external_user_id)
          WHERE status = 'ACTIVE' AND external_user_id IS NOT NULL
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          notification_messages_token = COALESCE(
            user_platform_mappings.notification_messages_token,
            EXCLUDED.notification_messages_token
          ),
          topic = COALESCE(EXCLUDED.topic, user_platform_mappings.topic),
          cadence = COALESCE(EXCLUDED.cadence, user_platform_mappings.cadence),
          status = 'ACTIVE',
          link_state = 'active',
          mapping_generation = CASE WHEN user_platform_mappings.link_state <> 'active'
            OR user_platform_mappings.user_id <> EXCLUDED.user_id
            THEN user_platform_mappings.mapping_generation + 1
            ELSE user_platform_mappings.mapping_generation END,
          revoked_at = NULL,
          revocation_reason = NULL,
          updated_at = now()
        -- #383 CAS guard: skip update when concurrent write changed the userId,
        -- preventing a check-then-write race from bypassing the relink policy.
        WHERE user_platform_mappings.user_id = EXCLUDED.user_id
          AND user_platform_mappings.mapping_generation = COALESCE($7::bigint, user_platform_mappings.mapping_generation)
        RETURNING *
      `,
        [
          PLATFORM,
          params.psid,
          params.userId,
          token,
          params.topic ?? null,
          params.cadence ?? null,
          params.expectedGeneration ?? null,
        ],
      );

    // #383: CAS guard may have blocked the update when a concurrent write
    // changed the userId — RETURNING yields no rows.
    if (rows.length === 0) {
      return null;
    }

    return this.mapEntity(this.mapRawRow(rows[0]));
  }

  async upsertPocSubscription(params: {
    psid: string;
    userId: number;
    cadence: NotificationCadence;
    topic: string;
    notificationMessagesToken: string;
  }): Promise<UserMessengerMapping> {
    const existing = await this.mappingRepo
      .createQueryBuilder('mapping')
      .where(
        '(mapping.platform = :platform AND mapping.externalUserId = :psid) OR mapping.notificationMessagesToken = :token',
        {
          platform: PLATFORM,
          psid: params.psid,
          token: params.notificationMessagesToken,
        },
      )
      .getOne();

    if (existing) {
      existing.platform = PLATFORM;
      existing.externalUserId = params.psid;
      existing.userId = params.userId;
      existing.notificationMessagesToken = params.notificationMessagesToken;
      existing.cadence = params.cadence;
      existing.topic = params.topic;
      existing.status = 'ACTIVE';
      existing.mappingGeneration =
        existing.linkState && existing.linkState !== 'active'
          ? String(BigInt(existing.mappingGeneration ?? '1') + 1n)
          : (existing.mappingGeneration ?? '1');
      existing.linkState = 'active';
      existing.lastVerifiedAt = new Date();
      existing.lastUnknownAt = null;
      existing.revokedAt = null;
      existing.revocationReason = null;

      const saved = await this.mappingRepo.save(existing);
      return this.mapEntity(saved);
    }

    const created = this.mappingRepo.create({
      userId: params.userId,
      platform: PLATFORM,
      externalUserId: params.psid,
      notificationMessagesToken: params.notificationMessagesToken,
      cadence: params.cadence,
      topic: params.topic,
      status: 'ACTIVE',
      linkState: 'active',
      mappingGeneration: '1',
    });

    const saved = await this.mappingRepo.save(created);
    return this.mapEntity(saved);
  }

  async clearReportSubscription(psid: string): Promise<void> {
    await this.mappingRepo
      .createQueryBuilder()
      .update(UserPlatformMappingEntity)
      .set({ cadence: null as never, topic: null as never })
      .where('platform = :platform', { platform: PLATFORM })
      .andWhere('externalUserId = :psid', { psid })
      .andWhere("status = 'ACTIVE'")
      .execute();
  }

  /** Consent opt-in via command (#596): Messenger's cron gates on cadence/topic. */
  async ensureReportSubscription(psid: string): Promise<void> {
    await this.mappingRepo
      .createQueryBuilder()
      .update(UserPlatformMappingEntity)
      .set({
        cadence: () => `COALESCE(cadence, 'daily')`,
        topic: () => `COALESCE(topic, '${DEFAULT_TOPIC}')`,
      })
      .where('platform = :platform', { platform: PLATFORM })
      .andWhere('externalUserId = :psid', { psid })
      .andWhere("status = 'ACTIVE'")
      .execute();
  }

  async findActiveSubscribedMappings(): Promise<UserMessengerMapping[]> {
    return this.findActiveSubscribedMappingsPage(0, Number.MAX_SAFE_INTEGER);
  }

  async findActiveSubscribedMappingsPage(
    afterId: number,
    limit: number,
  ): Promise<UserMessengerMapping[]> {
    const rows = await this.mappingRepo
      .createQueryBuilder('mapping')
      .select([
        'mapping.id',
        'mapping.platform',
        'mapping.externalUserId',
        'mapping.userId',
        'mapping.cadence',
        'mapping.topic',
      ])
      .where('mapping.status = :status', { status: 'ACTIVE' })
      .andWhere('mapping.platform = :platform', { platform: PLATFORM })
      .andWhere('mapping.cadence IS NOT NULL')
      .andWhere('mapping.topic IS NOT NULL')
      .andWhere('mapping.id > :afterId', { afterId })
      .orderBy('mapping.id', 'ASC')
      .take(limit)
      .getMany();

    return this.dedupeMappingsByPsid(
      rows
        .filter((row) => this.isUsableLink(row))
        .map((row) => this.mapEntity(row)),
    );
  }

  private dedupeMappingsByPsid(
    mappings: UserMessengerMapping[],
  ): UserMessengerMapping[] {
    const byPsid = new Map<string, UserMessengerMapping>();

    for (const mapping of mappings) {
      if (!mapping.psid) {
        byPsid.set(`mapping-${mapping.id}`, mapping);
        continue;
      }

      const existing = byPsid.get(mapping.psid);
      if (!existing) {
        byPsid.set(mapping.psid, mapping);
        continue;
      }

      if (
        existing.notificationMessagesToken.startsWith('poc:psid:') &&
        !mapping.notificationMessagesToken.startsWith('poc:psid:')
      ) {
        byPsid.set(mapping.psid, mapping);
      }
    }

    return Array.from(byPsid.values());
  }

  async cleanupActiveDuplicateMappings(): Promise<number> {
    const result = await this.mappingRepo.manager.query<Array<{ id: number }>>(
      `
      WITH keepers AS (
        SELECT DISTINCT ON (platform, external_user_id) id
        FROM user_platform_mappings
        WHERE platform = 'messenger'
          AND status = 'ACTIVE' AND external_user_id IS NOT NULL
        ORDER BY platform, external_user_id, id DESC
      )
      UPDATE user_platform_mappings
      SET status = 'INACTIVE', updated_at = now()
      WHERE status = 'ACTIVE'
        AND platform = 'messenger'
        AND external_user_id IS NOT NULL
        AND id NOT IN (SELECT id FROM keepers)
      RETURNING id
      `,
    );
    const byPsid = result.length;

    const byUser = await this.mappingRepo.manager.query<Array<{ id: number }>>(
      `
      WITH keepers AS (
        SELECT DISTINCT ON (user_id) id
        FROM user_platform_mappings
        WHERE platform = 'messenger'
          AND status = 'ACTIVE' AND user_id IS NOT NULL
        ORDER BY user_id, id DESC
      )
      UPDATE user_platform_mappings
      SET status = 'INACTIVE', updated_at = now()
      WHERE status = 'ACTIVE'
        AND platform = 'messenger'
        AND user_id IS NOT NULL
        AND id NOT IN (SELECT id FROM keepers)
      RETURNING id
      `,
    );

    return byPsid + byUser.length;
  }

  async deactivateConflictingActiveMappings(params: {
    psid: string;
    userId: number;
  }): Promise<void> {
    await this.mappingRepo.update(
      {
        userId: params.userId,
        platform: PLATFORM,
        externalUserId: Not(params.psid),
        status: 'ACTIVE',
      },
      { status: 'INACTIVE' },
    );

    await this.mappingRepo.update(
      {
        platform: PLATFORM,
        externalUserId: params.psid,
        userId: Not(params.userId),
        status: 'ACTIVE',
      },
      { status: 'INACTIVE' },
    );
  }

  async findActiveMappingsPage(
    afterId: number,
    limit: number,
  ): Promise<UserMessengerMapping[]> {
    const rows = await this.mappingRepo
      .createQueryBuilder('mapping')
      .leftJoin(
        'user_notification_preferences',
        'pref',
        'pref.user_id = mapping.user_id',
      )
      // Reminders are opt-out (#596): no consent row still receives them.
      .andWhere('COALESCE(pref.reminder_enabled, true) = true')
      .where('mapping.status = :status', { status: 'ACTIVE' })
      .andWhere('mapping.platform = :platform', { platform: PLATFORM })
      .andWhere('mapping.external_user_id IS NOT NULL')
      .andWhere('mapping.id > :afterId', { afterId })
      .orderBy('mapping.id', 'ASC')
      .take(limit)
      .getMany();

    return this.dedupeMappingsByPsid(
      rows
        .filter((row) => this.isUsableLink(row))
        .map((row) => this.mapEntity(row)),
    );
  }

  async hasSentScheduledReportToday(externalUserId: string): Promise<boolean> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const count = await this.logRepo
      .createQueryBuilder('log')
      .where('log.platform = :platform', { platform: PLATFORM })
      .andWhere('log.external_user_id = :externalUserId', {
        externalUserId,
      })
      .andWhere('log.status = :status', { status: 'SENT' })
      .andWhere(
        `(log.message_type = :primaryType
          OR log.message_type LIKE :partType
          OR log.message_type LIKE :legacyPartType)`,
        {
          primaryType: 'SCHEDULED_LEARNING_REPORT',
          partType: 'SCHEDULED_LEARNING_REPORT_PART_%',
          legacyPartType: 'SCHEDULED_LEARNING_REPORT_PSID_FALLBACK%',
        },
      )
      .andWhere('log.created_at >= :startOfDay', { startOfDay })
      .getCount();

    return count > 0;
  }

  async hasAnyPlatformSentReportToday(
    userId: number,
    reportDate: string,
  ): Promise<boolean> {
    const claim = await this.reportClaimRepo.findOne({
      where: { userId, reportDate, status: 'sent' },
    });
    return !!claim;
  }

  async listUserIdsWithSentReportToday(reportDate: string): Promise<number[]> {
    return listUserIdsWithSentReport(this.reportClaimRepo, reportDate);
  }

  async countMessageLogsByTypeSince(
    messageType: string,
    since: Date,
  ): Promise<number> {
    return this.logRepo
      .createQueryBuilder('log')
      .where('log.message_type = :messageType', { messageType })
      .andWhere('log.created_at >= :since', { since })
      .getCount();
  }

  async deleteMessageLogsOlderThan(cutoff: Date): Promise<number> {
    const BATCH_SIZE = 1000;
    let totalDeleted = 0;

    for (;;) {
      const ids: Array<{ id: number }> = await this.logRepo.query(
        `SELECT id FROM message_logs
         WHERE "platform" = $1 AND "created_at" < $2
         LIMIT $3`,
        [PLATFORM, cutoff, BATCH_SIZE],
      );

      if (ids.length === 0) break;

      const result = await this.logRepo
        .createQueryBuilder()
        .delete()
        .from(MessageLogEntity)
        .where('id IN (:...ids)', { ids: ids.map((r) => r.id) })
        .execute();

      totalDeleted += result.affected ?? 0;

      if (ids.length < BATCH_SIZE) {
        break;
      }
    }

    return totalDeleted;
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
    // ON CONFLICT DO UPDATE ... WHERE status = 'released': reclaims a claim
    // released after a transient failure, while an active `claimed` row is
    // never stolen by a concurrent worker and a `sent` claim stays
    // non-reclaimable.
    if (params.userId) {
      const activeOther = await this.reportClaimRepo
        .createQueryBuilder('claim')
        .where('claim.user_id = :userId', { userId: params.userId })
        .andWhere('claim.report_date = :reportDate', {
          reportDate: params.reportDate,
        })
        .andWhere('claim.platform != :platform', { platform: 'messenger' })
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
    }> = await this.reportClaimRepo.manager.query(
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
        PLATFORM,
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
    },
    leaseToken: string,
    deliveryRecord?: string,
    deliveryKey?: string,
    deliveryStatus?: OutboundDeliveryOutcome,
  ): Promise<boolean> {
    const result = await this.reportClaimRepo
      .createQueryBuilder()
      .update()
      .set({
        status: 'sent',
        ...(deliveryRecord !== undefined ? { deliveryRecord } : {}),
        ...(deliveryKey !== undefined ? { deliveryKey } : {}),
        ...(deliveryStatus !== undefined ? { deliveryStatus } : {}),
      })
      .where('platform = :platform', { platform: PLATFORM })
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
    const result = await this.reportClaimRepo
      .createQueryBuilder()
      .update()
      .set({ status: 'released' })
      .where('platform = :platform', { platform: PLATFORM })
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
    const result = await this.reportClaimRepo
      .createQueryBuilder()
      .update()
      .set({ status: 'released', updatedAt: now })
      .where('platform = :platform', { platform: PLATFORM })
      .andWhere('status = :status', { status: 'claimed' })
      .andWhere(
        '(lease_expires_at < :now OR (lease_expires_at IS NULL AND updated_at < :olderThan))',
        { now, olderThan },
      )
      .execute();

    return result.affected ?? 0;
  }

  async logMessage(params: {
    userId?: number;
    psid?: string;
    messageType: string;
    status: 'SENT' | 'FAILED';
    errorMessage?: string;
  }): Promise<MessengerMessageLog> {
    const created = this.logRepo.create({
      userId: params.userId ?? null,
      platform: PLATFORM,
      externalUserId: params.psid ?? null,
      messageType: params.messageType,
      status: params.status,
      errorMessage: params.errorMessage ?? null,
    });

    const saved = await this.logRepo.save(created);
    return this.mapLogEntity(saved);
  }

  /** Raw query rows come back snake_case — normalize to the entity shape. */
  private mapRawRow(row: Record<string, unknown>): UserPlatformMappingEntity {
    return {
      id: Number(row.id),
      userId:
        row.user_id === null || row.user_id === undefined
          ? null
          : Number(row.user_id),
      platform: String(row.platform),
      externalUserId:
        typeof row.external_user_id === 'string' ? row.external_user_id : null,
      notificationMessagesToken: String(row.notification_messages_token),
      cadence: (row.cadence as NotificationCadence | null) ?? null,
      topic: (row.topic as string | null) ?? null,
      status: (row.status as 'ACTIVE' | 'INACTIVE') ?? 'ACTIVE',
      linkState:
        (row.link_state as
          | 'active'
          | 'confirmed-revoked'
          | 'temporarily-unknown'
          | 'locally-unlinked') ?? 'active',
      mappingGeneration: String(row.mapping_generation ?? '1'),
      lastVerifiedAt: row.last_verified_at
        ? new Date(String(row.last_verified_at))
        : null,
      lastUnknownAt: row.last_unknown_at
        ? new Date(String(row.last_unknown_at))
        : null,
      revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
      revocationReason: (row.revocation_reason as string | null) ?? null,
      upstreamOwnershipVersion:
        (row.upstream_ownership_version as string | null) ?? null,
      createdAt: new Date(String(row.created_at)),
      updatedAt: new Date(String(row.updated_at)),
    };
  }

  private mapEntity(entity: UserPlatformMappingEntity): UserMessengerMapping {
    return {
      id: entity.id,
      userId: entity.userId ?? undefined,
      psid: entity.externalUserId ?? undefined,
      notificationMessagesToken: entity.notificationMessagesToken,
      cadence: entity.cadence ?? undefined,
      topic: entity.topic ?? undefined,
      status: entity.status,
      mappingGeneration: entity.mappingGeneration ?? '1',
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }

  private isUsableLink(entity: UserPlatformMappingEntity): boolean {
    return !entity.linkState || entity.linkState === 'active';
  }

  private mapLogEntity(entity: MessageLogEntity): MessengerMessageLog {
    return {
      id: entity.id,
      userId: entity.userId ?? undefined,
      psid: entity.externalUserId ?? undefined,
      messageType: entity.messageType,
      status: entity.status,
      errorMessage: entity.errorMessage ?? undefined,
      createdAt: entity.createdAt.toISOString(),
    };
  }
}
