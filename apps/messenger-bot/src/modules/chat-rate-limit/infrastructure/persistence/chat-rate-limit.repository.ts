import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  ChatRateLimitRepository as ChatMeteringRepository,
} from '@wispace/chat-metering';
import type {
  RecoverIdempotencyOutcome,
  ReserveFreeFormSlotInput,
  ReserveFreeFormSlotOutcome,
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

  reserveFreeFormSlotInTransaction(
    input: ReserveFreeFormSlotInput,
  ): Promise<ReserveFreeFormSlotOutcome> {
    return this.core.reserveFreeFormSlotInTransaction({
      externalUserId: input.psid,
      userId: input.userId,
      usageDate: input.usageDate,
      idempotencyKey: input.idempotencyKey,
      dailyLimit: input.dailyLimit,
      burstLimit: input.burstLimit,
      burstSince: input.burstSince,
      burstCountsRefunded: input.burstCountsRefunded,
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

  markDeliveredSlot(idempotencyKey: string): Promise<boolean> {
    return this.core.markDeliveredSlot(idempotencyKey);
  }

  countRecentReservations(
    psid: string,
    since: Date,
    options: { includeRefunded?: boolean } = {},
  ): Promise<number> {
    return this.core.countRecentReservations(psid, since, options);
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
}
