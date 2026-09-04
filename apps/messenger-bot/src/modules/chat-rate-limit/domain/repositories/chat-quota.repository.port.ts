import type {
  RecoverIdempotencyOutcome,
  ReserveFreeFormSlotInput,
  ReserveFreeFormSlotOutcome,
} from '../entities/chat-idempotency.types';

export const CHAT_QUOTA_REPOSITORY = Symbol('CHAT_QUOTA_REPOSITORY');

/**
 * Combined repository port for daily usage + idempotency transactions + recovery + ops.
 * Replaces the 4 separate ports (CHAT_USAGE_PORT, CHAT_RESERVATION_PORT,
 * CHAT_RECOVERY_PORT, CHAT_OPS_PORT) that all resolved to the same class.
 */
export interface ChatQuotaRepositoryPort {
  // ─── Daily usage ──────────────────────────────────────────────────────
  getDailyUsageCount(
    psid: string,
    usageDate: string,
    userId?: number,
  ): Promise<number>;

  // ─── Idempotency / reservation ────────────────────────────────────────
  reserveFreeFormSlotInTransaction(
    input: ReserveFreeFormSlotInput,
  ): Promise<ReserveFreeFormSlotOutcome>;
  refundReservedSlot(params: {
    psid: string;
    usageDate: string;
    idempotencyKey: string;
    releaseReason?: 'send_failed' | 'stuck_recover';
    userId?: number;
  }): Promise<boolean>;
  markDeliveredSlot(idempotencyKey: string): Promise<boolean>;
  completeReservedSlot(idempotencyKey: string): Promise<boolean>;
  countRecentReservations(
    psid: string,
    since: Date,
    options?: { includeRefunded?: boolean },
  ): Promise<number>;
  listBurstCountsForBucket(
    bucketStart: Date,
    bucketEnd: Date,
    options?: { includeRefunded?: boolean; limit?: number },
  ): Promise<{
    rows: Array<{ externalUserId: string; count: number }>;
    truncated: boolean;
  }>;

  // ─── Recovery ─────────────────────────────────────────────────────────
  recoverIdempotencyForRetry(
    idempotencyKey: string,
    stuckBefore: Date,
  ): Promise<RecoverIdempotencyOutcome>;
  recoverAllStuckReserved(stuckBefore: Date): Promise<string[]>;

  // ─── Ops ──────────────────────────────────────────────────────────────
  countStuckReserved(stuckBefore: Date): Promise<number>;
  countIdempotencyByStatusForUsageDate(
    usageDate: string,
  ): Promise<Record<string, number>>;
  countUsersAtOrAboveDailyLimit(
    usageDate: string,
    dailyLimit: number,
  ): Promise<number>;
}
