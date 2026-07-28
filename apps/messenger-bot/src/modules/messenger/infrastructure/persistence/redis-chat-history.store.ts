import { Inject, Injectable, Logger } from '@nestjs/common';
import { REDIS_CLIENT } from '../../../../infrastructure/redis/redis.client.port';
import type { RedisClientPort } from '../../../../infrastructure/redis/redis.client.port';
import type { ChatHistoryMessage } from '../../domain/entities/messenger-store.types';
import type { ChatHistoryStorePort } from '../../domain/repositories/chat-history.store.port';
import { MessengerChatSharedConfigService } from '../../application/services/messenger-chat-shared-config.service';

interface RedisChatHistoryPayload {
  messages: ChatHistoryMessage[];
}

@Injectable()
export class RedisChatHistoryStore implements ChatHistoryStorePort {
  private static readonly KEY_PREFIX = 'chat:history:';

  private readonly logger = new Logger(RedisChatHistoryStore.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redisClient: RedisClientPort,
    private readonly sharedConfig: MessengerChatSharedConfigService,
  ) {}

  isAvailable(): boolean {
    return (
      this.redisClient.isEnabled() &&
      this.redisClient.getNativeClient() !== null
    );
  }

  async getHistory(psid: string): Promise<ChatHistoryMessage[]> {
    const client = this.redisClient.getNativeClient();
    if (!client) {
      return [];
    }

    try {
      const raw = await client.get(this.key(psid));
      if (!raw) {
        return [];
      }

      const parsed = JSON.parse(raw) as RedisChatHistoryPayload;
      if (!Array.isArray(parsed.messages)) {
        return [];
      }

      return parsed.messages
        .filter(
          (m) =>
            m.role === 'user' ||
            m.role === 'assistant' ||
            m.role === 'tool_summary',
        )
        .map((message) => ({
          role: message.role,
          content: message.content,
        }));
    } catch (error) {
      this.logger.warn(
        `Redis chat history read failed psid=${psid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  async appendTurn(
    psid: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    const user = userText.trim();
    const assistant = assistantText.trim();
    if (!user || !assistant) {
      return;
    }

    const client = this.redisClient.getNativeClient();
    if (!client) {
      return;
    }

    try {
      const existing = await this.getHistory(psid);
      const messages = [
        ...existing,
        { role: 'user' as const, content: user },
        { role: 'assistant' as const, content: assistant },
      ].slice(-this.sharedConfig.getHistoryMaxMessages());

      const payload: RedisChatHistoryPayload = { messages };
      await client.set(
        this.key(psid),
        JSON.stringify(payload),
        'EX',
        this.ttlSeconds(),
      );
    } catch (error) {
      this.logger.warn(
        `Redis chat history write failed psid=${psid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async appendToolSummary(psid: string, summary: string): Promise<void> {
    const client = this.redisClient.getNativeClient();
    if (!client) {
      return;
    }

    try {
      const existing = await this.getHistory(psid);
      const messages = [
        ...existing,
        { role: 'tool_summary' as const, content: summary },
      ].slice(-this.sharedConfig.getHistoryMaxMessages());

      const payload: RedisChatHistoryPayload = { messages };
      await client.set(
        this.key(psid),
        JSON.stringify(payload),
        'EX',
        this.ttlSeconds(),
      );
    } catch (error) {
      this.logger.warn(
        `Redis chat history tool summary write failed psid=${psid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async clear(psid: string): Promise<void> {
    const client = this.redisClient.getNativeClient();
    if (!client) {
      return;
    }

    try {
      await client.del(this.key(psid));
    } catch (error) {
      this.logger.warn(
        `Redis chat history clear failed psid=${psid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private key(psid: string): string {
    return `${RedisChatHistoryStore.KEY_PREFIX}${psid}`;
  }

  private ttlSeconds(): number {
    return Math.max(1, Math.ceil(this.sharedConfig.getHistoryTtlMs() / 1000));
  }
}
