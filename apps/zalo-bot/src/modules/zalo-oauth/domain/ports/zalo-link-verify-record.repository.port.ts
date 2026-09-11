import type { LinkMappingObservation } from '@wispace/account-link-core/core';

/** Durable verify-intent outbox row candidate for reconciliation. */
export interface StaleZaloVerifyRecord {
  zaloUserId: string;
  userId: number;
  intentGeneration: string;
  verifiedAt: Date;
  mappingObservation: LinkMappingObservation;
}

/** A single pending verify intent (callback in flight). */
export interface PendingZaloVerifyRecord {
  userId: number;
  verifiedAt: Date;
}

/**
 * Persistence seam for the Zalo link verify-intent outbox
 * (`zalo_link_verify_records`) — mirror of the Discord flow (#137 → #147).
 */
export interface ZaloLinkVerifyRecordRepositoryPort {
  recordVerify(
    zaloUserId: string,
    userId: number,
    mappingObservation: LinkMappingObservation,
  ): Promise<{ intentGeneration: string }>;
  consumeRecord(input: {
    zaloUserId: string;
    userId: number;
    intentGeneration: string;
  }): Promise<boolean>;
  discardRecord(zaloUserId: string): Promise<void>;
  listStaleRecords(olderThanMs: number): Promise<StaleZaloVerifyRecord[]>;
  /** Pending intent for one Zalo id, when the callback is still in flight. */
  findPending(zaloUserId: string): Promise<PendingZaloVerifyRecord | undefined>;
}

export const ZALO_LINK_VERIFY_RECORD_REPOSITORY = Symbol(
  'ZALO_LINK_VERIFY_RECORD_REPOSITORY',
);
