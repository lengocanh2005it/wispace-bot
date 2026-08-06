import type { ChatHistoryMessage } from './types';

/** Implemented per app/backend (memory, Redis, ...). */
export interface ChatHistoryStorePort {
  getHistory(externalUserId: string): Promise<ChatHistoryMessage[]>;
  appendTurn(
    externalUserId: string,
    userText: string,
    assistantText: string,
  ): Promise<void>;
  /**
   * Append a tool_summary entry so next turns know what was looked up.
   * Optional — platforms without tool summaries don't implement it.
   */
  appendToolSummary?(externalUserId: string, summary: string): Promise<void>;
  clear(externalUserId: string): Promise<void>;
}
