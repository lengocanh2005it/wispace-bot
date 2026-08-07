import type {
  ChatIdempotencyStatus,
  ChatQuotaDenyReason,
} from '@wispace/database';

export type { ChatIdempotencyStatus } from '@wispace/database';

export interface ChatQuotaCheckResult {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  reason?: ChatQuotaDenyReason;
  usageDate: string;
  /** True when a DB quota slot was reserved (false for bypass / deny). */
  quotaReserved?: boolean;
}

export interface ChatRateLimitSettings {
  freeFormDailyLimit: number;
  burstPerMinute: number;
  timezone: string;
  /** Whether burst window counts refunded idempotency rows (default false). */
  burstCountsRefunded?: boolean;
}

export interface ChatIdempotencyRecord {
  idempotencyKey: string;
  externalUserId: string;
  userId?: number;
  usageDate: string;
  status: ChatIdempotencyStatus;
  reservedAt: Date;
}

export interface ReserveIdempotencyInput {
  idempotencyKey: string;
  externalUserId: string;
  userId?: number;
  usageDate: string;
}

export interface ReserveFreeFormSlotInput {
  externalUserId: string;
  userId?: number;
  usageDate: string;
  idempotencyKey: string;
  dailyLimit: number;
  /** Optional DB-authoritative burst check for Postgres-backed counters. */
  burstLimit?: number;
  burstSince?: Date;
}

export type ReserveFreeFormSlotOutcome =
  | { status: 'reserved'; freeFormCount: number }
  | { status: 'idempotency_conflict' }
  | { status: 'daily_limit_exceeded' }
  | { status: 'burst_limit_exceeded'; count: number };

/** Outcome when reclaiming an idempotency key stuck in `reserved` past TTL. */
export type RecoverIdempotencyOutcome =
  | 'reopened'
  | 'in_flight'
  | 'completed'
  | 'not_found';

export interface BurstCounterPort {
  getBurstCount(externalUserId: string): Promise<number>;
  /**
   * Atomically increment the burst counter and check against the limit.
   * Returns allowed=false (and does NOT increment) when already at or above limit.
   * Callers must call releaseReservation() if the downstream DB reserve later fails.
   */
  tryReserveBurst(
    externalUserId: string,
    limit: number,
  ): Promise<{ allowed: boolean; count: number }>;
  releaseReservation(externalUserId: string): Promise<void>;
}
