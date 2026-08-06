import type { ChatHistoryMessage } from './types';
import type { ChatHistoryStorePort } from './ports';

/**
 * Minimal Redis client interface — only the methods needed by chat history.
 */
export interface RedisChatHistoryClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode?: string,
    ttlSec?: number,
  ): Promise<'OK'>;
  del(key: string): Promise<number>;
}

const DEFAULT_KEY_PREFIX = 'chat-history:';

export interface RedisChatHistoryStoreConfig {
  /** TTL for each user's history in seconds. Default: 3600 (1 hour). */
  ttlSec: number;
  /** Max stored messages per user (2 per turn: user + assistant). Default: 40. */
  maxMessages: number;
  /** Key prefix, e.g. 'chat-history:messenger:' — platform-scoped to avoid cross-bot collisions. Default: 'chat-history:'. */
  keyPrefix?: string;
}

/**
 * Redis-backed chat history store for multi-pod deployments.
 * Each user's history is stored as a JSON array with a sliding TTL.
 */
export class RedisChatHistoryStore implements ChatHistoryStorePort {
  private readonly ttlSec: number;
  private readonly maxMessages: number;
  private readonly keyPrefix: string;

  constructor(
    private readonly redis: RedisChatHistoryClient,
    config?: Partial<RedisChatHistoryStoreConfig>,
  ) {
    this.ttlSec = config?.ttlSec ?? 3600;
    this.maxMessages = config?.maxMessages ?? 40;
    this.keyPrefix = config?.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  async getHistory(externalUserId: string): Promise<ChatHistoryMessage[]> {
    const raw = await this.redis.get(`${this.keyPrefix}${externalUserId}`);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as ChatHistoryMessage[]) : [];
    } catch {
      return [];
    }
  }

  async appendTurn(
    externalUserId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    const user = userText.trim();
    const assistant = assistantText.trim();
    if (!user || !assistant) return;

    const existing = await this.getHistory(externalUserId);
    const messages = [
      ...existing,
      { role: 'user' as const, content: user },
      { role: 'assistant' as const, content: assistant },
    ].slice(-this.maxMessages);

    await this.redis.set(
      `${this.keyPrefix}${externalUserId}`,
      JSON.stringify(messages),
      'EX',
      this.ttlSec,
    );
  }

  async appendToolSummary(
    externalUserId: string,
    summary: string,
  ): Promise<void> {
    const existing = await this.getHistory(externalUserId);
    const messages = [
      ...existing,
      { role: 'tool_summary' as const, content: summary },
    ].slice(-this.maxMessages);

    await this.redis.set(
      `${this.keyPrefix}${externalUserId}`,
      JSON.stringify(messages),
      'EX',
      this.ttlSec,
    );
  }

  async clear(externalUserId: string): Promise<void> {
    await this.redis.del(`${this.keyPrefix}${externalUserId}`);
  }
}
