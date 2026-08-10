import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';

export interface RouterContext {
  isDuplicateMid?: boolean;
  isDuplicatePostback?: boolean;
  userId?: number;
  linkContext?: MessengerLinkContext | null;
  shouldEnforceRateLimit?: boolean;
}
