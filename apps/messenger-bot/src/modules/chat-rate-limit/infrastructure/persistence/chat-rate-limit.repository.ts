import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  ChatRateLimitRepository as ChatMeteringRepository,
} from '@wispace/chat-metering';
import type { IncrementDailyUsageInput } from '../../domain/entities/chat-daily-usage.types';
import type {
  ChatIdempotencyRecord,
  ChatIdempotencyStatus,
  RecoverIdempotencyOutcome,
  ReserveFreeFormSlotInput,
  ReserveFreeFormSlotOutcome,
  ReserveIdempotencyInput,
} from '../../domain/entities/chat-idempotency.types';
import { ChatQuotaEventRecorderService } from '../../application/services/chat-quota-event-recorder.service';
import type { ChatQuotaRepositoryPort } from '../../domain/repositories/chat-quota.repository.port';

/** This repository only ever writes rows for the Messenger bot. */
const PLATFORM = 'messenger' as const;

@Injectable()
export class ChatRateLimitRepository implements ChatQuotaRepositoryPort {
  private readonly core: ChatMeteringRepository;

  constructor(
    @InjectRepository(ChatDailyUsageEntity)
    private readonly dailyUsageRepo: Repository<ChatDailyUsageEntity>,
    @InjectRepository(ChatIdempotencyEntity)
    private readonly idempotencyRepo: Repository<ChatIdempotencyEntity>,
    private readonly quotaEventRecorder: ChatQuotaEventRecorderService,
  ) {
    this.core = new ChatMeteringRepository(
      dailyUsageRepo,
      idempotencyRepo,
      PLATFORM,
      {
        onReserved: (manager, params) =>
          this.quotaEventRecorder.recordReservedInTransaction(manager, {
            psid: params.externalUserId,
            userId: params.userId,
            usageDate: params.usageDate,
            idempotencyKey: params.idempotencyKey,
            limit: params.limit,
            usedAfter: params.usedAfter,
          }),
        onReleased: (manager, params) =>
          this.quotaEventRecorder.recordReleasedInTransaction(manager, {
            psid: params.externalUserId,
            userId: params.userId,
            usageDate: params.usageDate,
            idempotencyKey: params.idempotencyKey,
            reason: params.reason,
            usedAfter: params.usedAfter,
          }),
      },
    );
  }

  getDailyUsageCount(psid: string, usageDate: string): Promise<number> {
    return this.core.getDailyUsageCount(psid, usageDate);
  }

  async incrementDailyUsage(input: IncrementDailyUsageInput): Promise<number> {
    const rows: Array<{ free_form_count: number }> =
      await this.dailyUsageRepo.manager.query(
        `
          INSERT INTO chat_daily_usage (platform, external_user_id, user_id, usage_date, free_form_count)
          VALUES ($1, $2, $3, $4::date, 1)
          ON CONFLICT (platform, external_user_id, usage_date)
          DO UPDATE SET
            free_form_count = chat_daily_usage.free_form_count + 1,
            user_id = COALESCE(EXCLUDED.user_id, chat_daily_usage.user_id),
            updated_at = now()
          RETURNING free_form_count
        `,
        [PLATFORM, input.psid, input.userId ?? null, input.usageDate],
      );

    return rows[0]?.free_form_count ?? 0;
  }

  async decrementDailyUsage(
    psid: string,
    usageDate: string,
  ): Promise<number | null> {
    const rows: Array<{ free_form_count: number }> =
      await this.dailyUsageRepo.manager.query(
        `
          UPDATE chat_daily_usage
          SET
            free_form_count = GREATEST(free_form_count - 1, 0),
            updated_at = now()
          WHERE platform = $1 AND external_user_id = $2 AND usage_date = $3::date
          RETURNING free_form_count
        `,
        [PLATFORM, psid, usageDate],
      );

    return rows[0]?.free_form_count ?? null;
  }

  async tryReserveIdempotency(
    input: ReserveIdempotencyInput,
  ): Promise<ChatIdempotencyRecord | null> {
    const record = await this.core.tryReserveIdempotency({
      idempotencyKey: input.idempotencyKey,
      externalUserId: input.psid,
      userId: input.userId,
      usageDate: input.usageDate,
    });

    return record ? this.toLegacyRecord(record) : null;
  }

  reserveFreeFormSlotInTransaction(
    input: ReserveFreeFormSlotInput,
  ): Promise<ReserveFreeFormSlotOutcome> {
    return this.core.reserveFreeFormSlotInTransaction({
      externalUserId: input.psid,
      userId: input.userId,
      usageDate: input.usageDate,
      idempotencyKey: input.idempotencyKey,
      dailyLimit: input.dailyLimit,
    });
  }

  refundReservedSlot(params: {
    psid: string;
    usageDate: string;
    idempotencyKey: string;
    releaseReason?: 'send_failed' | 'stuck_recover';
    userId?: number;
  }): Promise<boolean> {
    return this.core.refundReservedSlot({
      externalUserId: params.psid,
      usageDate: params.usageDate,
      idempotencyKey: params.idempotencyKey,
      releaseReason: params.releaseReason,
      userId: params.userId,
    });
  }

  completeReservedSlot(idempotencyKey: string): Promise<boolean> {
    return this.core.completeReservedSlot(idempotencyKey);
  }

  countRecentReservations(
    psid: string,
    since: Date,
    options: { includeRefunded?: boolean } = {},
  ): Promise<number> {
    return this.core.countRecentReservations(psid, since, options);
  }

  async updateIdempotencyStatus(
    idempotencyKey: string,
    status: ChatIdempotencyStatus,
  ): Promise<boolean> {
    const result = await this.idempotencyRepo.update(
      { platform: PLATFORM, idempotencyKey },
      { status },
    );

    return (result.affected ?? 0) > 0;
  }

  async getIdempotencyByKey(
    idempotencyKey: string,
  ): Promise<ChatIdempotencyRecord | null> {
    const row = await this.idempotencyRepo.findOne({
      where: { platform: PLATFORM, idempotencyKey },
    });

    if (!row) {
      return null;
    }

    return {
      idempotencyKey: row.idempotencyKey,
      psid: row.externalUserId,
      userId: row.userId ?? undefined,
      usageDate: row.usageDate,
      status: row.status,
      reservedAt: row.reservedAt,
    };
  }

  async listStuckReserved(stuckBefore: Date): Promise<ChatIdempotencyRecord[]> {
    const records = await this.core.listStuckReserved(stuckBefore);
    return records.map((record) => this.toLegacyRecord(record));
  }

  recoverIdempotencyForRetry(
    idempotencyKey: string,
    stuckBefore: Date,
  ): Promise<RecoverIdempotencyOutcome> {
    return this.core.recoverIdempotencyForRetry(idempotencyKey, stuckBefore);
  }

  recoverAllStuckReserved(stuckBefore: Date): Promise<string[]> {
    return this.core.recoverAllStuckReserved(stuckBefore);
  }

  async countStuckReserved(stuckBefore: Date): Promise<number> {
    return this.idempotencyRepo
      .createQueryBuilder('row')
      .where(`row.status = 'reserved'`)
      .andWhere('row.platform = :platform', { platform: PLATFORM })
      .andWhere('row.reserved_at < :stuckBefore', { stuckBefore })
      .getCount();
  }

  async countIdempotencyByStatusForUsageDate(
    usageDate: string,
  ): Promise<Record<string, number>> {
    const rows = await this.idempotencyRepo
      .createQueryBuilder('row')
      .select('row.status', 'status')
      .addSelect('COUNT(*)::int', 'count')
      .where('row.usage_date = :usageDate', { usageDate })
      .andWhere('row.platform = :platform', { platform: PLATFORM })
      .groupBy('row.status')
      .getRawMany<{ status: string; count: number }>();

    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }

  async countUsersAtOrAboveDailyLimit(
    usageDate: string,
    dailyLimit: number,
  ): Promise<number> {
    const row = await this.dailyUsageRepo
      .createQueryBuilder('usage')
      .select('COUNT(*)::int', 'count')
      .where('usage.usage_date = :usageDate', { usageDate })
      .andWhere('usage.platform = :platform', { platform: PLATFORM })
      .andWhere('usage.free_form_count >= :dailyLimit', { dailyLimit })
      .getRawOne<{ count: number }>();

    return row?.count ?? 0;
  }

  private toLegacyRecord(record: {
    idempotencyKey: string;
    externalUserId: string;
    userId?: number;
    usageDate: string;
    status: ChatIdempotencyStatus;
    reservedAt: Date;
  }): ChatIdempotencyRecord {
    return {
      idempotencyKey: record.idempotencyKey,
      psid: record.externalUserId,
      userId: record.userId,
      usageDate: record.usageDate,
      status: record.status,
      reservedAt: record.reservedAt,
    };
  }
}
