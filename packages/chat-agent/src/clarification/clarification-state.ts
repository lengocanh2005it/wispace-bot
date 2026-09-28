import type { RedisClientPort } from '@wispace/bot-common/redis';
import type {
  ClarificationChoice,
  ClarificationIrrelevantAction,
} from './clarification-text';

export const CLARIFICATION_TTL_MS = 10 * 60 * 1000;
export const MAX_CLARIFICATION_ATTEMPTS = 2;
export const MAX_CLARIFICATION_MENU_RESETS = 1;
const MAX_CLARIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CLARIFICATION_ATTEMPTS_CAP = 10;
const MAX_CLARIFICATION_MENU_RESETS_CAP = 5;
const MAX_CLARIFICATION_EVENT_HISTORY = 8;

export interface ClarificationLimits {
  ttlMs: number;
  maxAttempts: number;
  maxMenuResets: number;
}

export const DEFAULT_CLARIFICATION_LIMITS: ClarificationLimits = {
  ttlMs: CLARIFICATION_TTL_MS,
  maxAttempts: MAX_CLARIFICATION_ATTEMPTS,
  maxMenuResets: MAX_CLARIFICATION_MENU_RESETS,
};

export interface ClarificationConfigReader {
  get<T = string>(key: string): T | undefined;
}

export function readClarificationLimits(
  config: ClarificationConfigReader,
): ClarificationLimits {
  const readBound = (
    key: string,
    fallback: number,
    allowZero = false,
  ): number => {
    const raw = config.get<string>(key);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) &&
      (parsed > 0 || (allowZero && parsed === 0))
      ? Math.floor(parsed)
      : fallback;
  };
  return normalizeLimits({
    ttlMs: readBound('CHAT_CLARIFICATION_TTL_MS', CLARIFICATION_TTL_MS),
    maxAttempts: readBound(
      'CHAT_CLARIFICATION_MAX_ATTEMPTS',
      MAX_CLARIFICATION_ATTEMPTS,
      true,
    ),
    maxMenuResets: readBound(
      'CHAT_CLARIFICATION_MAX_MENU_RESETS',
      MAX_CLARIFICATION_MENU_RESETS,
      true,
    ),
  });
}

function normalizeLimits(limits: ClarificationLimits): ClarificationLimits {
  return {
    ttlMs: Math.min(
      Number.isFinite(limits.ttlMs) && limits.ttlMs > 0
        ? Math.floor(limits.ttlMs)
        : CLARIFICATION_TTL_MS,
      MAX_CLARIFICATION_TTL_MS,
    ),
    maxAttempts: Math.min(
      Number.isFinite(limits.maxAttempts) && limits.maxAttempts >= 0
        ? Math.floor(limits.maxAttempts)
        : MAX_CLARIFICATION_ATTEMPTS,
      MAX_CLARIFICATION_ATTEMPTS_CAP,
    ),
    maxMenuResets: Math.min(
      Number.isFinite(limits.maxMenuResets) && limits.maxMenuResets >= 0
        ? Math.floor(limits.maxMenuResets)
        : MAX_CLARIFICATION_MENU_RESETS,
      MAX_CLARIFICATION_MENU_RESETS_CAP,
    ),
  };
}

export interface ClarificationState {
  phase: 'awaiting_choice' | 'consumed';
  attempts: number;
  menuResets: number;
  version: number;
  createdAt: number;
  expiresAt: number;
  userId?: number;
  /** The most recent inbound event in the clarification lifecycle. */
  lastEventId?: string;
  /** Recent event ids form a bounded tombstone for delayed/replayed replies. */
  recentEventIds?: string[];
  /** Choice accepted for the most recent consumed event, if any. */
  lastChoice?: ClarificationChoice;
  /** Canned text cached so a redelivery can be suppressed deterministically. */
  lastReplyText?: string;
  /** A definitive outbound failure keeps the state retryable without deleting it. */
  lastDeliveryFailed?: boolean;
}

/** The single expiry rule, shared by the machine's query and the store's prune. */
function isClarificationStateExpired(
  state: ClarificationState,
  now: number,
): boolean {
  return state.expiresAt <= now;
}

export interface ClarificationStateStore {
  get(key: string): Promise<ClarificationState | null>;
  set(
    key: string,
    state: ClarificationState,
    expectedVersion?: number,
  ): Promise<boolean | void>;
  clear(key: string, expectedVersion?: number): Promise<boolean | void>;
}

export const CLARIFICATION_STATE_STORE = Symbol('CLARIFICATION_STATE_STORE');

export interface ClarificationIrrelevantResult {
  action: ClarificationIrrelevantAction;
  state?: ClarificationState;
}

export class ClarificationStateMachine {
  private readonly limits: ClarificationLimits;

  constructor(limits: ClarificationLimits = DEFAULT_CLARIFICATION_LIMITS) {
    this.limits = normalizeLimits(limits);
  }

  start(now = Date.now(), userId?: number): ClarificationState {
    return {
      phase: 'awaiting_choice',
      attempts: 0,
      menuResets: 0,
      version: 1,
      createdAt: now,
      expiresAt: now + this.limits.ttlMs,
      ...(userId === undefined ? {} : { userId }),
    };
  }

  isExpired(state: ClarificationState, now = Date.now()): boolean {
    return isClarificationStateExpired(state, now);
  }

  recordIrrelevant(
    state: ClarificationState,
    now = Date.now(),
  ): ClarificationIrrelevantResult {
    if (state.attempts < this.limits.maxAttempts) {
      return {
        action: 'clarify',
        state: {
          ...state,
          attempts: state.attempts + 1,
          version: state.version + 1,
          expiresAt: now + this.limits.ttlMs,
        },
      };
    }

    if (state.menuResets < this.limits.maxMenuResets) {
      return {
        action: 'reset_menu',
        state: {
          ...state,
          attempts: 0,
          menuResets: state.menuResets + 1,
          version: state.version + 1,
          expiresAt: now + this.limits.ttlMs,
        },
      };
    }

    return { action: 'clear' };
  }

  withReply(
    state: ClarificationState,
    eventId: string | undefined,
    replyText: string,
  ): ClarificationState {
    const recentEventIds = eventId
      ? [...(state.recentEventIds ?? []), eventId].slice(
          -MAX_CLARIFICATION_EVENT_HISTORY,
        )
      : state.recentEventIds;
    return {
      ...state,
      ...(eventId ? { lastEventId: eventId } : {}),
      ...(recentEventIds ? { recentEventIds } : {}),
      lastReplyText: replyText,
      lastDeliveryFailed: false,
    };
  }

  isStaleEvent(state: ClarificationState, eventId?: string): boolean {
    return Boolean(
      eventId &&
      state.lastEventId !== eventId &&
      state.recentEventIds?.includes(eventId),
    );
  }

  consume(
    state: ClarificationState,
    eventId: string | undefined,
    now = Date.now(),
    choice?: ClarificationChoice,
  ): ClarificationState {
    const recentEventIds = eventId
      ? [...(state.recentEventIds ?? []), eventId].slice(
          -MAX_CLARIFICATION_EVENT_HISTORY,
        )
      : state.recentEventIds;
    return {
      ...state,
      phase: 'consumed',
      version: state.version + 1,
      expiresAt: now + this.limits.ttlMs,
      ...(eventId ? { lastEventId: eventId } : {}),
      ...(recentEventIds ? { recentEventIds } : {}),
      ...(choice ? { lastChoice: choice } : {}),
    };
  }
}

const MAX_MEMORY_STATES = 10_000;

/** Bounded process-local store used when Redis is disabled (development/tests). */
export class MemoryClarificationStateStore implements ClarificationStateStore {
  private readonly states = new Map<string, ClarificationState>();

  async get(key: string): Promise<ClarificationState | null> {
    this.prune();
    return this.states.get(key) ?? null;
  }

  async set(
    key: string,
    state: ClarificationState,
    expectedVersion?: number,
  ): Promise<boolean> {
    this.prune();
    const currentVersion = this.states.get(key)?.version ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      return false;
    }
    this.states.set(key, state);
    if (this.states.size > MAX_MEMORY_STATES) {
      const oldest = this.states.keys().next().value as string | undefined;
      if (oldest !== undefined) this.states.delete(oldest);
    }
    return true;
  }

  async clear(key: string, expectedVersion?: number): Promise<boolean> {
    const current = this.states.get(key);
    if (
      expectedVersion !== undefined &&
      (!current || current.version !== expectedVersion)
    ) {
      return false;
    }
    return this.states.delete(key);
  }

  private prune(now = Date.now()): void {
    for (const [key, state] of this.states) {
      if (isClarificationStateExpired(state, now)) this.states.delete(key);
    }
  }
}

interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  del(key: string): Promise<number>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>;
}

/** Redis-backed state with a short TTL; configured Redis failures are fail-closed. */
export class RedisClarificationStateStore implements ClarificationStateStore {
  constructor(
    private readonly redisClient: {
      isConfiguredEnabled(): boolean;
      isEnabled(): boolean;
      getNativeClient(): unknown;
    },
    private readonly keyPrefix: string,
  ) {}

  async get(key: string): Promise<ClarificationState | null> {
    const client = this.client();
    const raw = await client.get(this.redisKey(key));
    if (!raw) return null;
    return this.parse(raw);
  }

  async set(
    key: string,
    state: ClarificationState,
    expectedVersion?: number,
  ): Promise<boolean> {
    const client = this.client();
    const ttlMs = Math.max(1, state.expiresAt - Date.now());
    const result = await client.eval(
      `
        local current = redis.call('get', KEYS[1])
        local expected = tonumber(ARGV[1])
        if current then
          local ok, decoded = pcall(cjson.decode, current)
          if not ok or tonumber(decoded.version) ~= expected then
            return 0
          end
        elseif expected ~= 0 then
          return 0
        end
        redis.call('psetex', KEYS[1], ARGV[2], ARGV[3])
        return 1
      `,
      1,
      this.redisKey(key),
      String(expectedVersion ?? 0),
      String(ttlMs),
      JSON.stringify(state),
    );
    return Number(result) === 1;
  }

  async clear(key: string, expectedVersion?: number): Promise<boolean> {
    const client = this.client();
    if (expectedVersion === undefined) {
      await client.del(this.redisKey(key));
      return true;
    }
    const result = await client.eval(
      `
        local current = redis.call('get', KEYS[1])
        if not current then return 0 end
        local ok, decoded = pcall(cjson.decode, current)
        if not ok or tonumber(decoded.version) ~= tonumber(ARGV[1]) then
          return 0
        end
        redis.call('del', KEYS[1])
        return 1
      `,
      1,
      this.redisKey(key),
      String(expectedVersion),
    );
    return Number(result) === 1;
  }

  private client(): RedisLikeClient {
    if (
      !this.redisClient.isConfiguredEnabled() ||
      !this.redisClient.isEnabled()
    ) {
      throw new Error('Redis clarification state unavailable');
    }
    const client = this.redisClient.getNativeClient();
    if (!client) {
      throw new Error('Redis clarification state unavailable');
    }
    return client as RedisLikeClient;
  }

  private redisKey(key: string): string {
    return `${this.keyPrefix}:${key}`;
  }

  private parse(raw: string): ClarificationState {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !(['awaiting_choice', 'consumed'] as unknown[]).includes(
        (parsed as { phase?: unknown }).phase,
      ) ||
      !Number.isInteger((parsed as { attempts?: unknown }).attempts) ||
      (parsed as { attempts: number }).attempts < 0 ||
      (parsed as { attempts: number }).attempts >
        MAX_CLARIFICATION_ATTEMPTS_CAP ||
      !Number.isInteger((parsed as { menuResets?: unknown }).menuResets) ||
      (parsed as { menuResets: number }).menuResets < 0 ||
      (parsed as { menuResets: number }).menuResets >
        MAX_CLARIFICATION_MENU_RESETS_CAP ||
      !Number.isInteger((parsed as { version?: unknown }).version) ||
      (parsed as { version: number }).version < 1 ||
      !Number.isFinite((parsed as { createdAt?: unknown }).createdAt) ||
      !Number.isFinite((parsed as { expiresAt?: unknown }).expiresAt) ||
      (parsed as { expiresAt: number }).expiresAt <=
        (parsed as { createdAt: number }).createdAt ||
      (parsed as { expiresAt: number }).expiresAt >
        (parsed as { createdAt: number }).createdAt +
          MAX_CLARIFICATION_TTL_MS ||
      ('userId' in parsed &&
        (parsed as { userId?: unknown }).userId !== undefined &&
        (!Number.isInteger((parsed as { userId?: unknown }).userId) ||
          (parsed as { userId: number }).userId < 1)) ||
      ('lastEventId' in parsed &&
        (parsed as { lastEventId?: unknown }).lastEventId !== undefined &&
        (typeof (parsed as { lastEventId?: unknown }).lastEventId !==
          'string' ||
          (parsed as { lastEventId: string }).lastEventId.length === 0 ||
          (parsed as { lastEventId: string }).lastEventId.length > 255)) ||
      ('lastChoice' in parsed &&
        (parsed as { lastChoice?: unknown }).lastChoice !== undefined &&
        !(['progress', 'schedule', 'reschedule'] as unknown[]).includes(
          (parsed as { lastChoice?: unknown }).lastChoice,
        )) ||
      ('lastReplyText' in parsed &&
        (parsed as { lastReplyText?: unknown }).lastReplyText !== undefined &&
        (typeof (parsed as { lastReplyText?: unknown }).lastReplyText !==
          'string' ||
          (parsed as { lastReplyText: string }).lastReplyText.length === 0 ||
          (parsed as { lastReplyText: string }).lastReplyText.length > 4000)) ||
      ('lastDeliveryFailed' in parsed &&
        (parsed as { lastDeliveryFailed?: unknown }).lastDeliveryFailed !==
          undefined &&
        typeof (parsed as { lastDeliveryFailed?: unknown })
          .lastDeliveryFailed !== 'boolean') ||
      ('recentEventIds' in parsed &&
        (parsed as { recentEventIds?: unknown }).recentEventIds !== undefined &&
        (!Array.isArray(
          (parsed as { recentEventIds?: unknown }).recentEventIds,
        ) ||
          (parsed as { recentEventIds: unknown[] }).recentEventIds.length >
            MAX_CLARIFICATION_EVENT_HISTORY ||
          (parsed as { recentEventIds: unknown[] }).recentEventIds.some(
            (eventId) =>
              typeof eventId !== 'string' ||
              eventId.length === 0 ||
              eventId.length > 255,
          )))
    ) {
      throw new Error('Invalid clarification state');
    }
    return parsed as ClarificationState;
  }
}

export function createClarificationStateStore(params: {
  platform: string;
  redisClient?: RedisClientPort;
}): ClarificationStateStore {
  if (params.redisClient?.isConfiguredEnabled?.() === true) {
    return new RedisClarificationStateStore(
      params.redisClient,
      `chat:clarification:${params.platform}`,
    );
  }
  return new MemoryClarificationStateStore();
}
