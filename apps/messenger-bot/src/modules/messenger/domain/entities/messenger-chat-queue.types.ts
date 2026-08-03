import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';

export interface EnqueueChatMessageInput {
  psid: string;
  userId?: number;
  userText: string;
  linkContext?: MessengerLinkContext;
  /** Meta message.mid — idempotency key for the last message in a debounce batch. */
  idempotencyKey?: string;
}
