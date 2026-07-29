import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import type { NotificationCadence } from '../entities/messenger.types';

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
  verifyFailureReason?: MessengerLinkVerifyFailureReason;
}

export type MessengerLinkAttemptStatus =
  | 'no_ref'
  | 'linked'
  | 'verify_failed'
  | 'blocked'
  | 'invalid_ref';

export interface MessengerLinkAttemptResult {
  status: MessengerLinkAttemptStatus;
  context?: MessengerLinkContext;
}
