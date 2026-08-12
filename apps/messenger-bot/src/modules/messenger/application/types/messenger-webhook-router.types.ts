import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';

export interface RouterContext {
  userId?: number;
  linkContext?: MessengerLinkContext | null;
  shouldEnforceRateLimit?: boolean;
}
