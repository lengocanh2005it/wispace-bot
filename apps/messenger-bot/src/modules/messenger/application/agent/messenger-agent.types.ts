import type { MessengerLinkContext } from '../../../../shared/config/poc.constants';
import type { ChatHistoryMessage } from '../../domain/entities/messenger-store.types';
import type { MessengerRichFollowUp } from '../../domain/entities/messenger-rich-message.types';

export interface MessengerAgentReply {
  text: string;
  richFollowUps: MessengerRichFollowUp[];
  exhausted?: boolean;
  toolSummary?: string;
}

/** Stream events from MessengerAgentService.replyStream() — done carries full MessengerAgentReply. */
export type MessengerAgentStreamEvent =
  | { type: 'delta'; textDelta: string }
  | { type: 'tool_start'; toolName: string }
  | { type: 'done'; reply: MessengerAgentReply }
  | { type: 'error'; error: unknown };

export interface MessengerAgentInput {
  psid: string;
  userId?: number;
  userText: string;
  linkContext?: MessengerLinkContext;
  history?: ChatHistoryMessage[];
  /** message.mid — LLM usage correlation id */
  correlationId?: string;
}
