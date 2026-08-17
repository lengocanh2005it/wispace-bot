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
  /**
   * EVAL a Lua script (ioredis array-arg form). `keys` are the script's
   * KEYS table; `args` are ARGV.
   */
  eval(
    script: string,
    numKeys: number,
    keys: string[],
    args: Array<string | number>,
  ): Promise<unknown>;
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
 * Appends new messages to a user's history atomically (#148): reads the
 * existing JSON array, appends, trims to `maxMessages`, and writes back with
 * a sliding TTL — all inside one server-side script, so concurrent appends
 * for the same user are serialized by Redis and can never lose a turn (no
 * read-modify-write GET/SET race).
 */
const APPEND_HISTORY_SCRIPT = `
local key = KEYS[1]
local max = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local newMessages = cjson.decode(ARGV[3])
local raw = redis.call('GET', key)
local existing = {}
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then
    existing = decoded
  end
end
for _, m in ipairs(newMessages) do
  table.insert(existing, m)
end
if #existing > max then
  local tail = {}
  for i = #existing - max + 1, #existing do
    table.insert(tail, existing[i])
  end
  existing = tail
end
redis.call('SET', key, cjson.encode(existing), 'EX', ttl)
return #existing
`;

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

    const messages = [
      { role: 'user' as const, content: user },
      { role: 'assistant' as const, content: assistant },
    ];
    await this.appendAtomic(externalUserId, messages);
  }

  async appendToolSummary(
    externalUserId: string,
    summary: string,
  ): Promise<void> {
    const messages = [{ role: 'tool_summary' as const, content: summary }];
    await this.appendAtomic(externalUserId, messages);
  }

  private async appendAtomic(
    externalUserId: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<void> {
    await this.redis.eval(
      APPEND_HISTORY_SCRIPT,
      1,
      [`${this.keyPrefix}${externalUserId}`],
      [this.maxMessages, this.ttlSec, JSON.stringify(messages)],
    );
  }

  async clear(externalUserId: string): Promise<void> {
    await this.redis.del(`${this.keyPrefix}${externalUserId}`);
  }
}
