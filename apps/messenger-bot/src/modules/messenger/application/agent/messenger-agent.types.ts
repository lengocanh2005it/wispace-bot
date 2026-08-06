import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import type { ChatHistoryMessage } from '../../domain/entities/messenger-store.types';
import type { MessengerRichFollowUp } from '../../domain/entities/messenger-rich-message.types';

export interface MessengerAgentReply {
  text: string;
  richFollowUps: MessengerRichFollowUp[];
  exhausted?: boolean;
  toolSummary?: string;
}

export interface MessengerAgentInput {
  psid: string;
  userId?: number;
  userText: string;
  linkContext?: MessengerLinkContext;
  history?: ChatHistoryMessage[];
  /** message.mid — LLM usage correlation id */
  correlationId?: string;
}
