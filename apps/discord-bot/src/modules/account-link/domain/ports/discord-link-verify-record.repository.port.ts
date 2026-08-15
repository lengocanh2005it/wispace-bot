/** Durable verify-intent outbox row candidate for reconciliation. */
export interface StaleVerifyRecord {
  discordUserId: string;
  userId: number;
  verifiedAt: Date;
}

/**
 * Persistence seam for the Discord link verify-intent outbox
 * (`discord_link_verify_records`). Implemented by the TypeORM repository in
 * `infrastructure/persistence/`.
 */
export interface DiscordLinkVerifyRecordRepositoryPort {
  recordVerify(discordUserId: string, userId: number): Promise<void>;
  consumeRecord(discordUserId: string): Promise<void>;
  listStaleRecords(olderThanMs: number): Promise<StaleVerifyRecord[]>;
}

export const DISCORD_LINK_VERIFY_RECORD_REPOSITORY = Symbol(
  'DISCORD_LINK_VERIFY_RECORD_REPOSITORY',
);
