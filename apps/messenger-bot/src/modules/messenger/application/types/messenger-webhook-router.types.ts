import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import type { MessengerLinkVerifyFailureReason } from '@messenger/modules/messenger/domain/types/messenger-link-verify.types';

/**
 * Outcome of verifying an event-carried referral ref (#383). Computed once
 * during pre-resolve so every Meta shape shares one verify+link pipeline and
 * a single-use token is never submitted twice.
 */
export interface RefVerification {
  status: 'verified' | 'committed' | 'blocked' | 'failed' | 'handoff_failed';
  /** Link context resolved for a verified or already-committed intent. */
  context?: MessengerLinkContext;
  /** Durable intent generation used for conditional completion. */
  intentGeneration?: string;
  /** Why verification failed — set only when status is 'failed'. */
  failureReason?: MessengerLinkVerifyFailureReason;
}

export interface RouterContext {
  userId?: number;
  linkContext?: MessengerLinkContext | null;
  shouldEnforceRateLimit?: boolean;
  refVerification?: RefVerification;
}
