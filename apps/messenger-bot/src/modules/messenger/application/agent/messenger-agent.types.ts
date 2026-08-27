import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import type { ChatHistoryMessage } from '../../domain/entities/messenger-store.types';
import type { MessengerRichFollowUp } from '../../domain/entities/messenger-rich-message.types';

export interface MessengerAgentReply {
  text: string;
  richFollowUps: MessengerRichFollowUp[];
  exhausted?: boolean;
  toolSummary?: string;
  skipHistory?: boolean;
  deliveryKey?: string;
  clarification?: boolean;
  skipDelivery?: boolean;
}

export interface MessengerAgentInput {
  psid: string;
  userId?: number;
  userText: string;
  linkContext?: MessengerLinkContext;
  history?: ChatHistoryMessage[];
  /** message.mid — LLM usage correlation id */
  correlationId?: string;
  /**
   * Optional caller cancellation signal — aborts the agent loop, in-flight
   * LLM requests and tool calls immediately. Undefined means no cancellation.
   */
  signal?: AbortSignal;
}
