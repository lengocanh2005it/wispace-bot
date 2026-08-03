import type { MessengerLinkAttemptStatus } from '../../domain/types/messenger-link-verify.types';

export interface RouterContext {
  isDuplicateMid?: boolean;
  isDuplicatePostback?: boolean;
  userId?: number;
  linkContext?: {
    ref: string;
    topic: string;
    cadence: string;
    userId: number;
  } | null;
  linkAttemptStatus?: MessengerLinkAttemptStatus;
  shouldEnforceRateLimit?: boolean;
}
