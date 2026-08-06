import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Not, Repository } from 'typeorm';
import { buildPocPsidToken } from '@messenger/shared/config/poc.constants';
import {
  MessageLogEntity,
  ScheduledReportClaimEntity,
  UserPlatformMappingEntity,
} from '@messenger/infrastructure/database/entities';
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
      where: { userId, status: 'ACTIVE' },
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
    const existing = await this.mappingRepo.findOne({
      where: { platform: PLATFORM, externalUserId: params.psid },
    });

    if (existing) {
      existing.userId = params.userId;
      existing.externalUserId = params.psid;
      existing.notificationMessagesToken =
        existing.notificationMessagesToken || token;
      existing.topic = params.topic ?? existing.topic;
      existing.cadence = params.cadence ?? existing.cadence;
      existing.status = 'ACTIVE';

      const saved = await this.mappingRepo.save(existing);
      return this.mapEntity(saved);
    }

    const created = this.mappingRepo.create({
      userId: params.userId,
      platform: PLATFORM,
      externalUserId: params.psid,
      notificationMessagesToken: token,
      topic: params.topic ?? null,
      cadence: params.cadence ?? null,
      status: 'ACTIVE',
    });

    const saved = await this.mappingRepo.save(created);
    return this.mapEntity(saved);
  }

  async upsertPocSubscription(params: {
    psid: string;
    userId: number;
    cadence: NotificationCadence;
    topic: string;
    notificationMessagesToken: string;
  }): Promise<UserMessengerMapping> {
    const existing =
      (await this.mappingRepo.findOne({
        where: { platform: PLATFORM, externalUserId: params.psid },
      })) ??
      (await this.mappingRepo.findOne({
        where: { notificationMessagesToken: params.notificationMessagesToken },
      }));

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
      .where('mapping.status = :status', { status: 'ACTIVE' })
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

  async findActiveMappingsWithPsid(): Promise<UserMessengerMapping[]> {
    const rows = await this.mappingRepo
      .createQueryBuilder('mapping')
      .where('mapping.status = :status', { status: 'ACTIVE' })
      .andWhere('mapping.external_user_id IS NOT NULL')
      .orderBy('mapping.id', 'DESC')
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
      createdAt: LessThan(cutoff),
    });

    return result.affected ?? 0;
  }

  async tryClaimScheduledReport(params: {
    externalUserId: string;
    userId?: number;
    reportDate: string;
  }): Promise<boolean> {
    const rows: Array<{ id: number }> =
      await this.reportClaimRepo.manager.query(
        `
        INSERT INTO scheduled_report_claims (platform, external_user_id, report_date, user_id, status)
        VALUES ($1, $2, $3::date, $4, 'claimed')
        ON CONFLICT (platform, external_user_id, report_date) DO NOTHING
        RETURNING id
      `,
        [
          PLATFORM,
          params.externalUserId,
          params.reportDate,
          params.userId ?? null,
        ],
      );

    return rows.length > 0;
  }

  async markScheduledReportClaimSent(params: {
    externalUserId: string;
    reportDate: string;
  }): Promise<void> {
    await this.reportClaimRepo.update(
      {
        platform: PLATFORM,
        externalUserId: params.externalUserId,
        reportDate: params.reportDate,
      },
      { status: 'sent' },
    );
  }

  async releaseScheduledReportClaim(params: {
    externalUserId: string;
    reportDate: string;
  }): Promise<void> {
    await this.reportClaimRepo.update(
      {
        platform: PLATFORM,
        externalUserId: params.externalUserId,
        reportDate: params.reportDate,
        status: 'claimed',
      },
      { status: 'released' },
    );
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
