import type { NotificationCadence } from '../entities/messenger.types';

export type MessengerLinkIntentState = 'pending' | 'processing' | 'committed';

/** Owner lease for the verify-to-mapping handoff. */
export const MESSENGER_LINK_INTENT_LEASE_MS = 60_000;

export interface MessengerLinkVerifyRecord {
  psid: string;
  userId: number;
  topic: string;
  cadence: NotificationCadence;
  refFingerprint: string | null;
  intentGeneration: string;
  status: MessengerLinkIntentState;
  verifiedAt: Date;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
}

export interface MessengerLinkVerifyRecordInput {
  psid: string;
  userId: number;
  topic: string;
  cadence: NotificationCadence;
  refFingerprint: string;
  leaseMs: number;
}

export interface MessengerLinkVerifyRecordResult {
  intentGeneration: string;
  intentState: MessengerLinkIntentState;
  /** Present only for the callback that persisted the new processing intent. */
  leaseToken?: string;
}

/** Durable verify-intent outbox row candidate for reconciliation. */
export type StaleVerifyRecord = MessengerLinkVerifyRecord;

export type MessengerLinkIntentClaimResult =
  | { status: 'claimed'; leaseToken: string }
  | { status: 'already_processing' | 'already_committed' | 'not_found' };

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
  findByPsid(psid: string): Promise<MessengerLinkVerifyRecord | null>;
  recordVerify(
    input: MessengerLinkVerifyRecordInput,
  ): Promise<MessengerLinkVerifyRecordResult>;
  claimRecord(params: {
    psid: string;
    userId: number;
    intentGeneration: string;
    leaseMs: number;
    leaseToken?: string;
  }): Promise<MessengerLinkIntentClaimResult>;
  completeRecord(params: {
    psid: string;
    userId: number;
    intentGeneration: string;
    leaseToken: string;
  }): Promise<'committed' | 'already_committed' | 'not_found'>;
  renewRecord(params: {
    psid: string;
    userId: number;
    intentGeneration: string;
    leaseToken: string;
    leaseMs: number;
  }): Promise<boolean>;
  discardRecord(psid: string, intentGeneration?: string): Promise<void>;
  listStaleRecords(olderThanMs: number): Promise<StaleVerifyRecord[]>;
  cleanupCommittedRecords(olderThanMs: number): Promise<number>;
}

export const MESSENGER_LINK_VERIFY_RECORD_REPOSITORY = Symbol(
  'MESSENGER_LINK_VERIFY_RECORD_REPOSITORY',
);
