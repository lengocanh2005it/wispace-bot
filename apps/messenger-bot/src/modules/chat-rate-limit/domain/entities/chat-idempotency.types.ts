export type ChatIdempotencyStatus =
  | 'reserved'
  | 'delivered'
  | 'completed'
  | 'refunded';

export interface ChatIdempotencyRecord {
  idempotencyKey: string;
  psid: string;
  userId?: number;
  usageDate: string;
  status: ChatIdempotencyStatus;
  reservedAt: Date;
}

export interface ReserveIdempotencyInput {
  idempotencyKey: string;
  psid: string;
  userId?: number;
  usageDate: string;
}

export interface ReserveFreeFormSlotInput {
  psid: string;
  userId?: number;
  usageDate: string;
  idempotencyKey: string;
  /** H3: hard cap inside the same transaction as idempotency insert. */
  dailyLimit: number;
  burstLimit?: number;
  burstSince?: Date;
  burstCountsRefunded?: boolean;
}

export type ReserveFreeFormSlotOutcome =
  | { status: 'reserved'; freeFormCount: number }
  | { status: 'idempotency_conflict' }
  | { status: 'daily_limit_exceeded' }
  | { status: 'burst_limit_exceeded'; count: number };

/** Outcome when reclaiming an idempotency key for Meta retry / crash recovery (H2). */
export type RecoverIdempotencyOutcome =
  | 'reopened'
  | 'in_flight'
  | 'delivered'
  | 'completed'
  | 'not_found';
