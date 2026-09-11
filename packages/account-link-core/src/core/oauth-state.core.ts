import { randomBytes } from 'node:crypto';

export interface OAuthStateRecord<TPayload> {
  payload: TPayload;
  createdAt: Date;
}

export interface OAuthStateStore<TPayload> {
  save(state: string, payload: TPayload, createdAt: Date): Promise<void>;
  consume(state: string): Promise<OAuthStateRecord<TPayload> | undefined>;
  cleanupExpired(before: Date, limit: number): Promise<void>;
}

export type OauthStateStore<TPayload> = OAuthStateStore<TPayload>;

export interface OAuthStateCoreOptions {
  ttlMs?: number;
  cleanupLimit?: number;
  now?: () => Date;
  generateState?: () => string;
  onCleanupError?: (error: unknown) => void;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_CLEANUP_LIMIT = 100;
// Fixed security bound: allowing an env override would weaken callback trust.
const MAX_FUTURE_SKEW_MS = 60_000;

export class OAuthStateCore<TPayload> {
  private readonly ttlMs: number;
  private readonly cleanupLimit: number;
  private readonly now: () => Date;
  private readonly generateState: () => string;

  constructor(
    private readonly store: OAuthStateStore<TPayload>,
    private readonly options: OAuthStateCoreOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.cleanupLimit = options.cleanupLimit ?? DEFAULT_CLEANUP_LIMIT;
    this.now = options.now ?? (() => new Date());
    this.generateState =
      options.generateState ?? (() => randomBytes(24).toString('hex'));
  }

  async create(payload: TPayload): Promise<string> {
    const state = this.generateState();
    const createdAt = this.now();
    await this.store.save(state, payload, createdAt);
    try {
      await this.store.cleanupExpired(
        new Date(createdAt.getTime() - this.ttlMs),
        this.cleanupLimit,
      );
    } catch (error) {
      this.options.onCleanupError?.(error);
    }
    return state;
  }

  async consume(state: string): Promise<TPayload | undefined> {
    const record = await this.store.consume(state);
    if (!record) return undefined;
    const createdAt = record.createdAt.getTime();
    const ageMs = this.now().getTime() - createdAt;
    if (
      !Number.isFinite(createdAt) ||
      ageMs > this.ttlMs ||
      ageMs < -MAX_FUTURE_SKEW_MS
    ) {
      return undefined;
    }
    return record.payload;
  }
}
