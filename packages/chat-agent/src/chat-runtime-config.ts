export type ChatStoreKind = 'memory' | 'redis';

export interface ChatHistoryRuntimeConfig {
  store: ChatStoreKind;
  ttlMs: number;
  maxMessages: number;
  maxUsers: number;
}

export interface ChatRuntimeConfigReader {
  get<T = string>(key: string): T | undefined;
}

type ChatRuntimeConfigSource =
  | Readonly<Record<string, string | undefined>>
  | ChatRuntimeConfigReader;

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_MAX_PENDING_MESSAGES = 20;
const DEFAULT_PROCESSING_STUCK_MS = 300_000;
const DEFAULT_HISTORY_TTL_MS = 1_800_000;
const DEFAULT_HISTORY_MAX_MESSAGES = 20;
const DEFAULT_HISTORY_MAX_USERS = 10_000;
const HISTORY_PREFIXES = ['CHAT_HISTORY_', 'ZALO_CHAT_HISTORY_'];
const HISTORY_SUFFIXES = ['STORE', 'TTL_MS', 'MAX_MESSAGES', 'MAX_USERS'];
const SNAPSHOT_KEYS = [
  'CHAT_QUEUE_STORE',
  'CHAT_HISTORY_STORE',
  'CHAT_QUEUE_SHARED',
  'CHAT_DEBOUNCE_MS',
  'CHAT_MAX_PENDING_MESSAGES',
  'CHAT_QUEUE_PROCESSING_STUCK_MS',
  ...HISTORY_PREFIXES.flatMap((prefix) =>
    HISTORY_SUFFIXES.map((suffix) => `${prefix}${suffix}`),
  ),
];

function isReader(
  source: ChatRuntimeConfigSource,
): source is ChatRuntimeConfigReader {
  return typeof (source as ChatRuntimeConfigReader).get === 'function';
}

function snapshotSource(
  source: ChatRuntimeConfigSource,
): Readonly<Record<string, string | undefined>> {
  if (!isReader(source)) {
    return Object.freeze({ ...source });
  }

  return Object.freeze(
    Object.fromEntries(
      SNAPSHOT_KEYS.map((key) => [key, source.get<string>(key)]),
    ),
  );
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function readFlag(value: unknown): boolean {
  return ['true', '1', 'yes'].includes(text(value)?.toLowerCase() ?? '');
}

function readFiniteNumber(value: unknown): number | undefined {
  const raw = text(value);
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = readFiniteNumber(value);
  return parsed !== undefined && parsed > 0 ? Math.floor(parsed) : fallback;
}

function resolveStore(value: unknown, shared: unknown): ChatStoreKind {
  const explicit = text(value)?.toLowerCase();
  if (explicit === 'memory' || explicit === 'redis') {
    return explicit;
  }

  return readFlag(shared) ? 'redis' : 'memory';
}

export class ChatRuntimeConfig {
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly resolvedQueueStore: ChatStoreKind;

  readonly legacyQueueShared: boolean;
  readonly debounceMs: number;
  readonly maxPendingSize: number;
  readonly processingStuckMs: number;

  constructor(source: ChatRuntimeConfigSource) {
    this.env = snapshotSource(source);
    this.legacyQueueShared = readFlag(this.env.CHAT_QUEUE_SHARED);
    this.resolvedQueueStore = resolveStore(
      this.env.CHAT_QUEUE_STORE,
      this.env.CHAT_QUEUE_SHARED,
    );

    const debounce = readFiniteNumber(this.env.CHAT_DEBOUNCE_MS);
    this.debounceMs =
      debounce !== undefined && debounce >= 0
        ? Math.min(Math.floor(debounce), 10_000)
        : DEFAULT_DEBOUNCE_MS;

    const pending = readFiniteNumber(this.env.CHAT_MAX_PENDING_MESSAGES);
    this.maxPendingSize =
      pending === 0
        ? 0
        : pending !== undefined && pending > 0
          ? Math.max(1, Math.floor(pending))
          : DEFAULT_MAX_PENDING_MESSAGES;

    this.processingStuckMs = readPositiveInteger(
      this.env.CHAT_QUEUE_PROCESSING_STUCK_MS,
      DEFAULT_PROCESSING_STUCK_MS,
    );
  }

  queueMode(): ChatStoreKind {
    return this.resolvedQueueStore;
  }

  history(envPrefix: string): ChatHistoryRuntimeConfig {
    const prefixedStore = this.env[`${envPrefix}STORE`];
    const legacyStore =
      envPrefix === 'CHAT_HISTORY_' ? undefined : this.env.CHAT_HISTORY_STORE;
    return Object.freeze({
      store: resolveStore(
        prefixedStore === undefined ? legacyStore : prefixedStore,
        this.env.CHAT_QUEUE_SHARED,
      ),
      ttlMs: readPositiveInteger(
        this.env[`${envPrefix}TTL_MS`],
        DEFAULT_HISTORY_TTL_MS,
      ),
      maxMessages: readPositiveInteger(
        this.env[`${envPrefix}MAX_MESSAGES`],
        DEFAULT_HISTORY_MAX_MESSAGES,
      ),
      maxUsers: readPositiveInteger(
        this.env[`${envPrefix}MAX_USERS`],
        DEFAULT_HISTORY_MAX_USERS,
      ),
    });
  }

  get<T = string>(key: string): T | undefined {
    return this.env[key] as T | undefined;
  }
}
