import type { LinkMappingObservation } from '@wispace/account-link-core/core';

/** Durable verify-intent outbox row candidate for reconciliation. */
export interface StaleVerifyRecord {
  discordUserId: string;
  userId: number;
  intentGeneration: string;
  verifiedAt: Date;
  mappingObservation: LinkMappingObservation;
}

/** A single pending verify intent (callback in flight). */
export interface PendingVerifyRecord {
  userId: number;
  verifiedAt: Date;
}

/**
 * Persistence seam for the Discord link verify-intent outbox
 * (`discord_link_verify_records`). Implemented by the TypeORM repository in
 * `infrastructure/persistence/`.
 */
export interface DiscordLinkVerifyRecordRepositoryPort {
  recordVerify(
    discordUserId: string,
    userId: number,
    mappingObservation: LinkMappingObservation,
  ): Promise<{ intentGeneration: string }>;
  consumeRecord(input: {
    discordUserId: string;
    userId: number;
    intentGeneration: string;
  }): Promise<boolean>;
  discardRecord(discordUserId: string): Promise<void>;
  listStaleRecords(olderThanMs: number): Promise<StaleVerifyRecord[]>;
  /** Pending intent for one Discord id, when the callback is still in flight. */
  findPending(discordUserId: string): Promise<PendingVerifyRecord | undefined>;
}

export const DISCORD_LINK_VERIFY_RECORD_REPOSITORY = Symbol(
  'DISCORD_LINK_VERIFY_RECORD_REPOSITORY',
);
