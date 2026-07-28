import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MemoryChatHistoryStore,
  type ChatHistoryMessage,
} from '@wispace/chat-history';

import { REDIS_CLIENT } from '../../../../infrastructure/redis/redis.client.port';
import type { Redis } from 'ioredis';

const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const KEY_PREFIX = 'chat-history:';

@Injectable()
export class ZaloChatHistoryService {
  private readonly store: MemoryChatHistoryStore;
  private readonly redisNative: Redis | null;
  private readonly redisTtlSec: number;
  private readonly maxMessages: number;

  constructor(
    configService: ConfigService,

    @Inject(REDIS_CLIENT) redis: any,
  ) {
    const ttlMs =
      Number(configService.get<string>('ZALO_CHAT_HISTORY_TTL_MS')) ||
      DEFAULT_TTL_MS;
    this.maxMessages =
      Number(configService.get<string>('ZALO_CHAT_HISTORY_MAX_MESSAGES')) ||
      DEFAULT_MAX_MESSAGES;
    this.redisTtlSec = Math.floor(ttlMs / 1000);
    const storeKind = configService
      .get<string>('CHAT_HISTORY_STORE')
      ?.trim()
      ?.toLowerCase();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
    const isEnabled = redis?.isEnabled?.() ?? false;
    this.redisNative =
      storeKind === 'redis' && isEnabled
        ? // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
          (redis.getNativeClient() as Redis | null)
        : null;
    this.store = new MemoryChatHistoryStore({
      ttlMs,
      maxMessages: this.maxMessages,
    });
  }

  async getHistory(zaloUserId: string): Promise<ChatHistoryMessage[]> {
    if (this.redisNative) {
      try {
        const raw = await this.redisNative.get(`${KEY_PREFIX}${zaloUserId}`);
        if (!raw) return [];
        return JSON.parse(raw) as ChatHistoryMessage[];
      } catch {
        return [];
      }
    }
    return this.store.getHistory(zaloUserId);
  }

  async appendTurn(
    zaloUserId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    if (this.redisNative) {
      try {
        const existing = await this.getHistory(zaloUserId);
        const messages = [
          ...existing,
          { role: 'user' as const, content: userText.trim() },
          { role: 'assistant' as const, content: assistantText.trim() },
        ].slice(-this.maxMessages);
        await this.redisNative.set(
          `${KEY_PREFIX}${zaloUserId}`,
          JSON.stringify(messages),
          'EX',
          this.redisTtlSec,
        );
      } catch {
        // swallow
      }
      return;
    }
    return this.store.appendTurn(zaloUserId, userText, assistantText);
  }
}
