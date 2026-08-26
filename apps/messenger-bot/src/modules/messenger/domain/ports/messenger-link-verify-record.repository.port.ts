/** Durable verify-intent outbox row candidate for reconciliation. */
export interface StaleVerifyRecord {
  psid: string;
  userId: number;
  verifiedAt: Date;
}

/**
 * Persistence seam for the Messenger link verify-intent outbox
 * (`messenger_link_verify_records`). Implemented by the TypeORM repository in
 * `infrastructure/persistence/`.
 */
export interface MessengerLinkVerifyRecordRepositoryPort {
  recordVerify(psid: string, userId: number): Promise<void>;
  consumeRecord(psid: string): Promise<void>;
  listStaleRecords(olderThanMs: number): Promise<StaleVerifyRecord[]>;
}

export const MESSENGER_LINK_VERIFY_RECORD_REPOSITORY = Symbol(
  'MESSENGER_LINK_VERIFY_RECORD_REPOSITORY',
);
