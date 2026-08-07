import type {
  ChatQuotaDeniedPayload,
  ChatQuotaReleaseReason,
  ChatQuotaReservedPayload,
  ChatQuotaReleasedPayload,
} from '../entities/chat-quota-event.types';

/**
 * Opaque transaction context — the domain doesn't know about TypeORM.
 * The infrastructure adapter casts the real EntityManager to this type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TransactionManager = any;

export const CHAT_QUOTA_EVENT_REPOSITORY = Symbol(
  'CHAT_QUOTA_EVENT_REPOSITORY',
);

export interface InsertChatQuotaReservedInput {
  psid: string;
  userId?: number;
  usageDate: string;
  idempotencyKey: string;
  payload: ChatQuotaReservedPayload;
}

export interface InsertChatQuotaReleasedInput {
  psid: string;
  userId?: number;
  usageDate: string;
  idempotencyKey: string;
  reason: ChatQuotaReleaseReason;
  payload: ChatQuotaReleasedPayload;
}

export interface InsertChatQuotaDeniedInput {
  psid: string;
  userId?: number;
  usageDate: string;
  payload: ChatQuotaDeniedPayload;
}

export interface ChatQuotaEventRepositoryPort {
  insertReservedInTransaction(
    manager: TransactionManager,
    input: InsertChatQuotaReservedInput,
  ): Promise<void>;

  insertReleasedInTransaction(
    manager: TransactionManager,
    input: InsertChatQuotaReleasedInput,
  ): Promise<void>;

  insertDenied(input: InsertChatQuotaDeniedInput): Promise<void>;

  deleteOlderThan(cutoff: Date): Promise<number>;
}
