import { subMilliseconds } from 'date-fns';
import { todayInTimezone as todayUsageDate } from '@wispace/date-utils';
import { maskExternalId } from '@wispace/bot-common';
import { CHAT_BURST_WINDOW_MS } from './memory-burst-counter';
import type {
  BurstCounterPort,
  ChatQuotaCheckResult,
  ChatRateLimitRepositoryPort,
  ChatRateLimitSettings,
  RecoverIdempotencyOutcome,
} from './types';

export interface ChatRateLimitLogger {
  warn(message: string): void;
  log(message: string): void;
}

const NOOP_LOGGER: ChatRateLimitLogger = {
  warn: () => undefined,
  log: () => undefined,
};

/** Default 10 minutes — stuck `reserved` recovery cutoff. */
const DEFAULT_STUCK_RESERVED_MS = 600_000;

/**
 * Platform-agnostic quota engine shared across WISPACE bots — burst window +
 * daily hard-cap reserve/refund, both backed by Postgres
 * (`chat_daily_usage` / `chat_idempotency`, keyed by `(platform, external_user_id)`).
 *
 * Callers own: enable/disable + whitelist policy, metrics, and deciding
 * *whether* to call these methods at all — this class assumes enforcement
 * is already "on" for the given call.
 */
export class ChatRateLimitCore {
  constructor(
    private readonly repository: ChatRateLimitRepositoryPort,
    private readonly burstCounter: BurstCounterPort,
    private readonly settings: ChatRateLimitSettings,
    private readonly logger: ChatRateLimitLogger = NOOP_LOGGER,
    private readonly stuckReservedMs = DEFAULT_STUCK_RESERVED_MS,
  ) {}

  async checkQuota(externalUserId: string): Promise<ChatQuotaCheckResult> {
    const { freeFormDailyLimit, timezone } = this.settings;
    const usageDate = todayUsageDate(timezone);
    const used = await this.repository.getDailyUsageCount(
      externalUserId,
      usageDate,
    );

    return this.buildQuotaResult(used, freeFormDailyLimit, usageDate);
  }

  async reserveFreeFormSlot(
    externalUserId: string,
    params: { userId?: number; idempotencyKey: string },
  ): Promise<ChatQuotaCheckResult> {
    const { freeFormDailyLimit, burstPerMinute, timezone } = this.settings;
    const usageDate = todayUsageDate(timezone);
    const burstSince = subMilliseconds(new Date(), CHAT_BURST_WINDOW_MS);

    const burstResult = await this.burstCounter.tryReserveBurst(
      externalUserId,
      burstPerMinute,
    );
    if (!burstResult.allowed) {
      this.logQuotaDeny(
        'BURST_LIMIT',
        externalUserId,
        params.idempotencyKey,
        burstResult.count,
        burstPerMinute,
      );
      return {
        allowed: false,
        used: burstResult.count,
        limit: burstPerMinute,
        remaining: 0,
        reason: 'BURST_LIMIT',
        usageDate,
        quotaReserved: false,
      };
    }

    return this.reserveAndRollbackBurstOnFailure(externalUserId, {
      userId: params.userId,
      usageDate,
      idempotencyKey: params.idempotencyKey,
      dailyLimit: freeFormDailyLimit,
      freeFormDailyLimit,
      burstLimit: burstPerMinute,
      burstSince,
      burstTransactional: burstResult.transactional,
      burstCountsRefunded: this.settings.burstCountsRefunded ?? false,
    });
  }

  async refundFreeFormSlot(
    externalUserId: string,
    usageDate: string,
    idempotencyKey: string,
    options?: { userId?: number },
  ): Promise<void> {
    const refunded = await this.repository.refundReservedSlot({
      externalUserId,
      usageDate,
      idempotencyKey,
      releaseReason: 'send_failed',
      userId: options?.userId,
    });

    if (refunded) {
      if (!this.settings.burstCountsRefunded) {
        await this.burstCounter.releaseReservation(externalUserId);
      }

      this.logger.warn(
        `CHAT_QUOTA_REFUND externalUserId=${maskExternalId(
          externalUserId,
        )} idempotencyKey=${idempotencyKey} usageDate=${usageDate}`,
      );
    }
  }

  async markCompleted(idempotencyKey: string): Promise<void> {
    await this.repository.completeReservedSlot(idempotencyKey);
  }

  async markDelivered(idempotencyKey: string): Promise<void> {
    await this.repository.markDeliveredSlot(idempotencyKey);
  }

  /** Finalize delivered keys and refund pre-delivery keys stuck past TTL. */
  async recoverStuckReservedSlots(): Promise<{ recovered: string[] }> {
    const stuckBefore = this.stuckReservedCutoff();
    const recovered =
      await this.repository.recoverAllStuckReserved(stuckBefore);

    if (recovered.length > 0) {
      // #293 known limitation: some `reserved` rows may have been delivered
      // before the worker crashed. Recovery refunds them anyway, causing a
      // quota under-count. The crash window is milliseconds; full fix
      // requires an intermediate `sending` state (deferred to follow-up).
      this.logger.warn(
        `CHAT_QUOTA_RECOVERED count=${recovered.length} keys=${recovered.join(',')}`,
      );
    }

    return { recovered };
  }

  private stuckReservedCutoff(): Date {
    return subMilliseconds(new Date(), this.stuckReservedMs);
  }

  private async reserveAndRollbackBurstOnFailure(
    externalUserId: string,
    params: {
      userId?: number;
      usageDate: string;
      idempotencyKey: string;
      dailyLimit: number;
      freeFormDailyLimit: number;
      burstLimit: number;
      burstSince: Date;
      burstTransactional: boolean;
      burstCountsRefunded: boolean;
    },
  ): Promise<ChatQuotaCheckResult> {
    const outcome = await this.reserveSlotOrRecoverOnConflict(externalUserId, {
      userId: params.userId,
      usageDate: params.usageDate,
      idempotencyKey: params.idempotencyKey,
      dailyLimit: params.dailyLimit,
      burstLimit: params.burstTransactional ? params.burstLimit : undefined,
      burstSince: params.burstTransactional ? params.burstSince : undefined,
      burstCountsRefunded: params.burstTransactional
        ? params.burstCountsRefunded
        : undefined,
    });

    if (outcome.status === 'burst_limit_exceeded') {
      await this.burstCounter.releaseReservation(externalUserId);
      this.logQuotaDeny(
        'BURST_LIMIT',
        externalUserId,
        params.idempotencyKey,
        outcome.count,
        params.burstLimit,
      );
      return {
        allowed: false,
        used: outcome.count,
        limit: params.burstLimit,
        remaining: 0,
        reason: 'BURST_LIMIT',
        usageDate: params.usageDate,
        quotaReserved: false,
      };
    }

    if (outcome.status === 'daily_limit_exceeded') {
      await this.burstCounter.releaseReservation(externalUserId);
      const used = params.dailyLimit;
      this.logQuotaDeny(
        'DAILY_LIMIT',
        externalUserId,
        params.idempotencyKey,
        used,
        params.freeFormDailyLimit,
      );
      return {
        allowed: false,
        used,
        limit: params.freeFormDailyLimit,
        remaining: 0,
        reason: 'DAILY_LIMIT',
        usageDate: params.usageDate,
        quotaReserved: false,
      };
    }

    if (outcome.status === 'idempotency_conflict') {
      await this.burstCounter.releaseReservation(externalUserId);
      return {
        allowed: false,
        used: 0,
        limit: params.freeFormDailyLimit,
        remaining: params.freeFormDailyLimit,
        reason: 'IDEMPOTENCY_CONFLICT',
        usageDate: params.usageDate,
        quotaReserved: false,
      };
    }

    return {
      allowed: true,
      used: outcome.freeFormCount,
      limit: params.freeFormDailyLimit,
      remaining: Math.max(params.freeFormDailyLimit - outcome.freeFormCount, 0),
      usageDate: params.usageDate,
      quotaReserved: true,
    };
  }

  private async reserveSlotOrRecoverOnConflict(
    externalUserId: string,
    input: {
      userId?: number;
      usageDate: string;
      idempotencyKey: string;
      dailyLimit: number;
      burstLimit?: number;
      burstSince?: Date;
      burstCountsRefunded?: boolean;
    },
  ) {
    let outcome = await this.repository.reserveFreeFormSlotInTransaction({
      externalUserId,
      userId: input.userId,
      usageDate: input.usageDate,
      idempotencyKey: input.idempotencyKey,
      dailyLimit: input.dailyLimit,
      burstLimit: input.burstLimit,
      burstSince: input.burstSince,
      burstCountsRefunded: input.burstCountsRefunded,
    });

    if (
      outcome.status !== 'idempotency_conflict' &&
      outcome.status !== 'daily_limit_exceeded'
    ) {
      return outcome;
    }

    if (outcome.status === 'daily_limit_exceeded') {
      return outcome;
    }

    const recovery = await this.repository.recoverIdempotencyForRetry(
      input.idempotencyKey,
      this.stuckReservedCutoff(),
    );

    if (recovery === 'reopened') {
      this.logger.log(
        `Reopened idempotency key=${input.idempotencyKey} externalUserId=${maskExternalId(
          externalUserId,
        )} for retry`,
      );
      outcome = await this.repository.reserveFreeFormSlotInTransaction({
        externalUserId,
        userId: input.userId,
        usageDate: input.usageDate,
        idempotencyKey: input.idempotencyKey,
        dailyLimit: input.dailyLimit,
        burstLimit: input.burstLimit,
        burstSince: input.burstSince,
        burstCountsRefunded: input.burstCountsRefunded,
      });
    } else {
      this.logIdempotencyConflict(
        input.idempotencyKey,
        externalUserId,
        recovery,
      );
    }

    return outcome;
  }

  private logIdempotencyConflict(
    idempotencyKey: string,
    externalUserId: string,
    recovery: RecoverIdempotencyOutcome,
  ): void {
    if (recovery === 'in_flight') {
      this.logger.log(
        `Idempotency in flight key=${idempotencyKey} externalUserId=${maskExternalId(
          externalUserId,
        )}; skip duplicate`,
      );
      return;
    }

    if (recovery === 'completed') {
      this.logger.log(
        `Idempotency already completed key=${idempotencyKey} externalUserId=${maskExternalId(
          externalUserId,
        )}; skip duplicate`,
      );
      return;
    }

    if (recovery === 'delivered') {
      this.logger.log(
        `Idempotency delivery pending finalization key=${idempotencyKey} externalUserId=${maskExternalId(
          externalUserId,
        )}; skip duplicate`,
      );
    }
  }

  private logQuotaDeny(
    reason: 'DAILY_LIMIT' | 'BURST_LIMIT',
    externalUserId: string,
    idempotencyKey: string,
    used: number,
    limit: number,
  ): void {
    this.logger.warn(
      `CHAT_QUOTA_DENY reason=${reason} externalUserId=${maskExternalId(
        externalUserId,
      )} idempotencyKey=${idempotencyKey} used=${used} limit=${limit}`,
    );
  }

  private buildQuotaResult(
    used: number,
    limit: number,
    usageDate: string,
  ): ChatQuotaCheckResult {
    const remaining = Math.max(limit - used, 0);

    return {
      allowed: used < limit,
      used,
      limit,
      remaining,
      reason: used >= limit ? 'DAILY_LIMIT' : undefined,
      usageDate,
      quotaReserved: false,
    };
  }
}
