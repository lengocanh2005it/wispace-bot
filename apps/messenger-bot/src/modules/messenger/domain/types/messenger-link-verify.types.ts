import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import type { NotificationCadence } from '../entities/messenger.types';
import type { MessengerLinkIntentState } from '../ports/messenger-link-verify-record.repository.port';

export type MessengerLinkVerifyFailureReason =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'USED'
  | 'INVALID_FORMAT';

export interface MessengerLinkVerifySuccess {
  valid: true;
  userId: number;
  topic: string;
  cadence: NotificationCadence;
}

export interface MessengerLinkVerifyFailure {
  valid: false;
  reason: MessengerLinkVerifyFailureReason;
}

export type MessengerLinkVerifyResult =
  | MessengerLinkVerifySuccess
  | MessengerLinkVerifyFailure;

export interface MessengerLinkResolveOutcome {
  context?: MessengerLinkContext;
  intentGeneration?: string;
  intentState?: MessengerLinkIntentState;
  /** Owner lease returned only to the callback that persisted the intent. */
  intentLeaseToken?: string;
  verifyFailureReason?: MessengerLinkVerifyFailureReason;
  handoffFailure?: boolean;
}

export type MessengerLinkAttemptStatus =
  | 'no_ref'
  | 'linked'
  | 'already_committed'
  | 'verify_failed'
  | 'handoff_failed'
  | 'blocked'
  | 'invalid_ref';

export interface MessengerLinkAttemptResult {
  status: MessengerLinkAttemptStatus;
  context?: MessengerLinkContext;
}
