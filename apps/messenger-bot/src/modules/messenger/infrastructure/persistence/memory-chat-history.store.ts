import { Injectable } from '@nestjs/common';
import { MemoryChatHistoryStore as MemoryChatHistoryStoreCore } from '@wispace/chat-history';
import type { ChatHistoryMessage } from '../../domain/entities/messenger-store.types';
import type { ChatHistoryStorePort } from '../../domain/repositories/chat-history.store.port';
import { MessengerChatSharedConfigService } from '../../application/services/messenger-chat-shared-config.service';

@Injectable()
export class MemoryChatHistoryStore implements ChatHistoryStorePort {
  private readonly core: MemoryChatHistoryStoreCore;
  /** Pending tool summaries inserted after the latest appendTurn. */
  private readonly pendingSummaries = new Map<string, string[]>();

  constructor(sharedConfig: MessengerChatSharedConfigService) {
    this.core = new MemoryChatHistoryStoreCore({
      ttlMs: sharedConfig.getHistoryTtlMs(),
      maxMessages: sharedConfig.getHistoryMaxMessages(),
    });
  }

  async getHistory(psid: string): Promise<ChatHistoryMessage[]> {
    const base = await this.core.getHistory(psid);
    const summaries = this.pendingSummaries.get(psid) ?? [];
    if (summaries.length === 0) return base;
    return [
      ...base,
      ...summaries.map((s) => ({ role: 'tool_summary' as const, content: s })),
    ];
  }

  async appendTurn(
    psid: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    // Summaries were visible via getHistory(); discard once the turn is committed.
    this.pendingSummaries.delete(psid);
    return this.core.appendTurn(psid, userText, assistantText);
  }

  appendToolSummary(psid: string, summary: string): Promise<void> {
    const list = this.pendingSummaries.get(psid) ?? [];
    list.push(summary);
    this.pendingSummaries.set(psid, list);
    return Promise.resolve();
  }

  async clear(psid: string): Promise<void> {
    this.pendingSummaries.delete(psid);
    return this.core.clear(psid);
  }
}
