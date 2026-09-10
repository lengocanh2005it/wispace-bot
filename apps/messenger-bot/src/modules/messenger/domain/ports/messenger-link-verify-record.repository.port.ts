import type { NotificationCadence } from '../entities/messenger.types';

export type MessengerLinkIntentState = 'pending' | 'committed';

export interface MessengerLinkVerifyRecord {
  psid: string;
  userId: number;
  topic: string;
  cadence: NotificationCadence;
  refFingerprint: string | null;
  intentGeneration: string;
  status: MessengerLinkIntentState;
  verifiedAt: Date;
}

export interface MessengerLinkVerifyRecordInput {
  psid: string;
  userId: number;
  topic: string;
  cadence: NotificationCadence;
  refFingerprint: string;
}

/** Durable verify-intent outbox row candidate for reconciliation. */
export type StaleVerifyRecord = MessengerLinkVerifyRecord;

/**
 * Persistence seam for the Messenger link verify-intent outbox
 * (`messenger_link_verify_records`). Implemented by the TypeORM repository in
 * `infrastructure/persistence/`.
 */
export interface MessengerLinkVerifyRecordRepositoryPort {
  findByRefFingerprint(
    psid: string,
    refFingerprint: string,
  ): Promise<MessengerLinkVerifyRecord | null>;
  recordVerify(
    input: MessengerLinkVerifyRecordInput,
  ): Promise<{ intentGeneration: string }>;
  consumeRecord(params: {
    psid: string;
    userId: number;
    intentGeneration: string;
  }): Promise<'committed' | 'already_committed' | 'not_found'>;
  discardRecord(psid: string, intentGeneration?: string): Promise<void>;
  listStaleRecords(olderThanMs: number): Promise<StaleVerifyRecord[]>;
  cleanupCommittedRecords(olderThanMs: number): Promise<number>;
}

export const MESSENGER_LINK_VERIFY_RECORD_REPOSITORY = Symbol(
  'MESSENGER_LINK_VERIFY_RECORD_REPOSITORY',
);
