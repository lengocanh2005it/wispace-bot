import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Not, Repository } from 'typeorm';
import { buildPocPsidToken } from '@messenger/shared/config/poc.constants';
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

    return row ? this.mapEntity(row) : null;
  }

  async findActiveMappingByUserId(
    userId: number,
  ): Promise<UserMessengerMapping | null> {
    const row = await this.mappingRepo.findOne({
      where: { platform: PLATFORM, userId, status: 'ACTIVE' },
      order: { id: 'DESC' },
    });

    if (!row?.externalUserId) {
      return null;
    }

    return this.mapEntity(row);
  }

  async upsertPsidUserLink(params: {
    psid: string;
    userId: number;
    topic?: string;
    cadence?: NotificationCadence;
  }): Promise<UserMessengerMapping> {
    const token = buildPocPsidToken(params.psid);

    // 1. Re-activate a previously deactivated mapping (keeps its id) — the
    //    INSERT below can only conflict with ACTIVE rows, so an INACTIVE row
    //    would otherwise be left behind while a duplicate ACTIVE row is created.
    await this.mappingRepo.manager.query(
      `
      UPDATE user_platform_mappings
      SET
        user_id = $3,
        notification_messages_token = COALESCE(notification_messages_token, $4),
        topic = COALESCE($5, topic),
        cadence = COALESCE($6, cadence),
        status = 'ACTIVE',
        updated_at = now()
      WHERE platform = $1
        AND external_user_id = $2
        AND status = 'INACTIVE'
    `,
      [
        PLATFORM,
        params.psid,
        params.userId,
        token,
        params.topic ?? null,
        params.cadence ?? null,
      ],
    );

    // 2. Atomic upsert against the partial unique index
    //    (platform, external_user_id WHERE status='ACTIVE'): concurrent link
    //    events (opt-ins have no mid, so dedupe never filters them) can no
    //    longer race findOne→save into a unique-violation 500. The conflict
    //    target must match the index columns exactly or Postgres raises 42P10.
    const rows: Array<Record<string, unknown>> =
      await this.mappingRepo.manager.query(
        `
        INSERT INTO user_platform_mappings
          (platform, external_user_id, user_id, notification_messages_token, topic, cadence, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
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
          updated_at = now()
        RETURNING *
      `,
        [
          PLATFORM,
          params.psid,
          params.userId,
          token,
          params.topic ?? null,
          params.cadence ?? null,
        ],
      );

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
    });

    const saved = await this.mappingRepo.save(created);
    return this.mapEntity(saved);
  }

  async findActiveSubscribedMappings(): Promise<UserMessengerMapping[]> {
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
      .orderBy('mapping.id', 'DESC')
      .getMany();

    return this.dedupeMappingsByPsid(rows.map((row) => this.mapEntity(row)));
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
      .where('mapping.status = :status', { status: 'ACTIVE' })
      .andWhere('mapping.platform = :platform', { platform: PLATFORM })
      .andWhere('mapping.external_user_id IS NOT NULL')
      .andWhere('mapping.id > :afterId', { afterId })
      .orderBy('mapping.id', 'ASC')
      .take(limit)
      .getMany();

    return this.dedupeMappingsByPsid(rows.map((row) => this.mapEntity(row)));
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
    const result = await this.logRepo.delete({
      platform: PLATFORM,
      createdAt: LessThan(cutoff),
    });

    return result.affected ?? 0;
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
  }> {
    // ON CONFLICT DO UPDATE ... WHERE status = 'released': reclaims a claim
    // released after a transient failure, while an active `claimed` row is
    // never stolen by a concurrent worker and a `sent` claim stays
    // non-reclaimable.
    const rows: Array<{
      id: number;
      lease_token: string;
      delivery_record: string | null;
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
        RETURNING id, lease_token, delivery_record
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
        }
      : { claimed: false };
  }

  async markScheduledReportClaimSent(
    params: {
      externalUserId: string;
      reportDate: string;
    },
    leaseToken: string,
  ): Promise<boolean> {
    const result = await this.reportClaimRepo
      .createQueryBuilder()
      .update()
      .set({ status: 'sent' })
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
    messageText: string;
    status: 'SENT' | 'FAILED';
    errorMessage?: string;
  }): Promise<MessengerMessageLog> {
    const created = this.logRepo.create({
      userId: params.userId ?? null,
      platform: PLATFORM,
      externalUserId: params.psid ?? null,
      messageType: params.messageType,
      messageText: params.messageText,
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
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }

  private mapLogEntity(entity: MessageLogEntity): MessengerMessageLog {
    return {
      id: entity.id,
      userId: entity.userId ?? undefined,
      psid: entity.externalUserId ?? undefined,
      messageType: entity.messageType,
      messageText: entity.messageText,
      status: entity.status,
      errorMessage: entity.errorMessage ?? undefined,
      createdAt: entity.createdAt.toISOString(),
    };
  }
}
