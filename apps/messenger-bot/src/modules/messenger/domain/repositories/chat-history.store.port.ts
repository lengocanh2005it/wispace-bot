import type { ChatHistoryMessage } from '../entities/messenger-store.types';

export const CHAT_HISTORY_STORE = Symbol('CHAT_HISTORY_STORE');

export interface ChatHistoryStorePort {
  getHistory(psid: string): Promise<ChatHistoryMessage[]>;
  appendTurn(
    psid: string,
    userText: string,
    assistantText: string,
  ): Promise<void>;
  /** Append a tool_summary entry so next turns know what was looked up. */
  appendToolSummary(psid: string, summary: string): Promise<void>;
  clear(psid: string): Promise<void>;
}
