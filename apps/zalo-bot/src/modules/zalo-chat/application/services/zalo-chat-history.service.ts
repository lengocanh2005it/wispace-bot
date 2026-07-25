import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MemoryChatHistoryStore,
  type ChatHistoryMessage,
} from '@wispace/chat-history';

const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * In-memory only (MVP) — lost on process restart, not shared across pods.
 * Same trade-off as apps/discord-bot's DiscordChatHistoryService — see spec
 * §11.7 for the Redis-backed future work.
 */
@Injectable()
export class ZaloChatHistoryService {
  private readonly store: MemoryChatHistoryStore;

  constructor(configService: ConfigService) {
    const ttlMs =
      Number(configService.get<string>('ZALO_CHAT_HISTORY_TTL_MS')) ||
      DEFAULT_TTL_MS;
    const maxMessages =
      Number(configService.get<string>('ZALO_CHAT_HISTORY_MAX_MESSAGES')) ||
      DEFAULT_MAX_MESSAGES;

    this.store = new MemoryChatHistoryStore({ ttlMs, maxMessages });
  }

  getHistory(zaloUserId: string): Promise<ChatHistoryMessage[]> {
    return this.store.getHistory(zaloUserId);
  }

  appendTurn(
    zaloUserId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    return this.store.appendTurn(zaloUserId, userText, assistantText);
  }
}
