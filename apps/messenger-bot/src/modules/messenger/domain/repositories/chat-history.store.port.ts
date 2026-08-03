import type {
  ChatHistoryMessage,
  ChatHistoryStorePort as BaseChatHistoryStorePort,
} from '@wispace/chat-history';

export type { ChatHistoryMessage };

export const CHAT_HISTORY_STORE = Symbol('CHAT_HISTORY_STORE');

export interface ChatHistoryStorePort extends BaseChatHistoryStorePort {
  /** Append a tool_summary entry so next turns know what was looked up. */
  appendToolSummary(psid: string, summary: string): Promise<void>;
}
