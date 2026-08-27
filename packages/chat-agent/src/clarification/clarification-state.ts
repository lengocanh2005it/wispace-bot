export const CLARIFICATION_TTL_MS = 10 * 60 * 1000;
export const MAX_CLARIFICATION_ATTEMPTS = 2;
export const MAX_CLARIFICATION_MENU_RESETS = 1;

export type ClarificationChoice = 'progress' | 'schedule' | 'reschedule';

export interface ClarificationState {
  phase: 'awaiting_choice';
  attempts: number;
  menuResets: number;
  version: number;
  createdAt: number;
  expiresAt: number;
  userId?: number;
  /** The inbound event that produced the last canned reply. */
  lastEventId?: string;
  /** Canned text cached so a redelivery can be suppressed deterministically. */
  lastReplyText?: string;
  /** A definitive outbound failure keeps the state retryable without deleting it. */
  lastDeliveryFailed?: boolean;
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

export type ClarificationIrrelevantAction = 'clarify' | 'reset_menu' | 'clear';

export interface ClarificationIrrelevantResult {
  action: ClarificationIrrelevantAction;
  state?: ClarificationState;
}

const DIACRITIC_MARKS = /[\u0300-\u036f]/g;

/** Normalize Vietnamese text for the small, deterministic clarification parser. */
export function normalizeClarificationText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/đ/gi, 'd')
    .replace(DIACRITIC_MARKS, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const CANCEL_WORDS = new Set([
  'bo',
  'bo qua',
  'cancel',
  'dung',
  'huy',
  'khong can',
  'khong',
  'n',
  'no',
  'skip',
  'thoat',
]);

const CHOICE_ALIASES: ReadonlyArray<
  readonly [ClarificationChoice, ...string[]]
> = [
  [
    'progress',
    'chon mot',
    '1',
    'mot',
    'tien do',
    'progress',
    'first',
    '1st',
    'first one',
    'the first one',
    'cai thu 1',
    'cai thu nhat',
    'lua chon thu nhat',
    'chon 1',
    'option 1',
    'choice 1',
    'lua chon 1',
    'td',
  ],
  [
    'schedule',
    'chon hai',
    '2',
    'hai',
    'lich',
    'lich hoc',
    'schedule',
    'second',
    '2nd',
    'second one',
    'the second one',
    'cai thu 2',
    'cai thu hai',
    'lua chon thu hai',
    'chon 2',
    'option 2',
    'choice 2',
    'lua chon 2',
    'lh',
  ],
  [
    'reschedule',
    'chon ba',
    '3',
    'ba',
    'doi lich',
    'doi lai lich',
    'reschedule',
    'third',
    '3rd',
    'third one',
    'the third one',
    'cai thu 3',
    'cai thu ba',
    'lua chon thu ba',
    'chon 3',
    'option 3',
    'choice 3',
    'lua chon 3',
    'dl',
  ],
];

const EXPLICIT_CHOICE_ALIASES: ReadonlyArray<
  readonly [ClarificationChoice, ...string[]]
> = [
  [
    'progress',
    '1',
    'mot',
    'first',
    '1st',
    'first one',
    'the first one',
    'cai thu 1',
    'cai thu nhat',
    'lua chon thu nhat',
    'chon mot',
    'chon 1',
    'option 1',
    'choice 1',
    'lua chon 1',
    'td',
  ],
  [
    'schedule',
    '2',
    'hai',
    'second',
    '2nd',
    'second one',
    'the second one',
    'cai thu 2',
    'cai thu hai',
    'lua chon thu hai',
    'chon hai',
    'chon 2',
    'option 2',
    'choice 2',
    'lua chon 2',
    'lh',
  ],
  [
    'reschedule',
    '3',
    'ba',
    'third',
    '3rd',
    'third one',
    'the third one',
    'cai thu 3',
    'cai thu ba',
    'lua chon thu ba',
    'chon ba',
    'chon 3',
    'option 3',
    'choice 3',
    'lua chon 3',
    'dl',
  ],
];

function isChoiceSuffix(value: string): boolean {
  return /^(?:nhe|nha|a|di|voi|giup minh|cho minh)$/.test(value);
}

export class ClarificationStateMachine {
  parseChoice(text: string): ClarificationChoice | null {
    const normalized = normalizeClarificationText(text);
    if (!normalized) return null;

    for (const [choice, ...aliases] of CHOICE_ALIASES) {
      if (aliases.includes(normalized)) return choice;
      const parts = normalized.split(' ');
      for (const alias of aliases) {
        const aliasParts = alias.split(' ');
        const suffix = parts.slice(aliasParts.length).join(' ');
        if (
          parts.length > aliasParts.length &&
          parts.slice(0, aliasParts.length).join(' ') === alias &&
          isChoiceSuffix(suffix)
        ) {
          return choice;
        }
      }
    }
    return null;
  }

  /** Multiple offered choices in one batch are contradictory, not an intent. */
  isContradictory(text: string): boolean {
    const lines = text.split(/\r?\n/);
    const lineChoices = lines
      .map((line) => this.parseChoice(line))
      .filter((choice): choice is ClarificationChoice => choice !== null);
    if (new Set(lineChoices).size > 1) return true;

    const tokens = normalizeClarificationText(text).split(' ').filter(Boolean);
    if (tokens.length === 0) return false;

    let matches = 0;
    for (const [, ...aliases] of EXPLICIT_CHOICE_ALIASES) {
      const matched = aliases.some((alias) => {
        const aliasTokens = alias.split(' ');
        return tokens.some((_, index) =>
          aliasTokens.every(
            (token, offset) => tokens[index + offset] === token,
          ),
        );
      });
      if (matched) matches += 1;
    }
    return matches > 1;
  }

  isCancel(text: string): boolean {
    return CANCEL_WORDS.has(normalizeClarificationText(text));
  }

  start(now = Date.now(), userId?: number): ClarificationState {
    return {
      phase: 'awaiting_choice',
      attempts: 0,
      menuResets: 0,
      version: 1,
      createdAt: now,
      expiresAt: now + CLARIFICATION_TTL_MS,
      ...(userId === undefined ? {} : { userId }),
    };
  }

  isExpired(state: ClarificationState, now = Date.now()): boolean {
    return state.expiresAt <= now;
  }

  recordIrrelevant(
    state: ClarificationState,
    now = Date.now(),
  ): ClarificationIrrelevantResult {
    if (state.attempts < MAX_CLARIFICATION_ATTEMPTS) {
      return {
        action: 'clarify',
        state: this.bump(state, now, { attempts: state.attempts + 1 }),
      };
    }

    if (state.menuResets < MAX_CLARIFICATION_MENU_RESETS) {
      return {
        action: 'reset_menu',
        state: this.bump(state, now, {
          attempts: 0,
          menuResets: state.menuResets + 1,
        }),
      };
    }

    return { action: 'clear' };
  }

  private bump(
    state: ClarificationState,
    now: number,
    changes: Partial<Pick<ClarificationState, 'attempts' | 'menuResets'>>,
  ): ClarificationState {
    return {
      ...state,
      ...changes,
      version: state.version + 1,
      expiresAt: now + CLARIFICATION_TTL_MS,
    };
  }

  withReply(
    state: ClarificationState,
    eventId: string | undefined,
    replyText: string,
  ): ClarificationState {
    return {
      ...state,
      ...(eventId ? { lastEventId: eventId } : {}),
      lastReplyText: replyText,
      lastDeliveryFailed: false,
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
      if (state.expiresAt <= now) this.states.delete(key);
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
    private readonly memory = new MemoryClarificationStateStore(),
  ) {}

  async get(key: string): Promise<ClarificationState | null> {
    const client = this.client();
    if (!client) return this.memory.get(key);
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
    if (!client) {
      return (await this.memory.set(key, state, expectedVersion)) !== false;
    }
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
    if (!client) {
      return (await this.memory.clear(key, expectedVersion)) !== false;
    }
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

  private client(): RedisLikeClient | null {
    if (!this.redisClient.isConfiguredEnabled()) {
      return null;
    }
    if (!this.redisClient.isEnabled()) {
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
      (parsed as { phase?: unknown }).phase !== 'awaiting_choice' ||
      !Number.isInteger((parsed as { attempts?: unknown }).attempts) ||
      (parsed as { attempts: number }).attempts < 0 ||
      (parsed as { attempts: number }).attempts > MAX_CLARIFICATION_ATTEMPTS ||
      !Number.isInteger((parsed as { menuResets?: unknown }).menuResets) ||
      (parsed as { menuResets: number }).menuResets < 0 ||
      (parsed as { menuResets: number }).menuResets >
        MAX_CLARIFICATION_MENU_RESETS ||
      !Number.isInteger((parsed as { version?: unknown }).version) ||
      (parsed as { version: number }).version < 1 ||
      !Number.isFinite((parsed as { createdAt?: unknown }).createdAt) ||
      !Number.isFinite((parsed as { expiresAt?: unknown }).expiresAt) ||
      (parsed as { expiresAt: number }).expiresAt <=
        (parsed as { createdAt: number }).createdAt ||
      (parsed as { expiresAt: number }).expiresAt >
        (parsed as { createdAt: number }).createdAt + CLARIFICATION_TTL_MS ||
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
          .lastDeliveryFailed !== 'boolean')
    ) {
      throw new Error('Invalid clarification state');
    }
    return parsed as ClarificationState;
  }
}
