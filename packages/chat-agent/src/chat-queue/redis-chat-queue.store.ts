import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { REDIS_CLIENT } from '@wispace/bot-common/redis';
import type { RedisClientPort } from '@wispace/bot-common/redis';
import type { Platform } from '@wispace/contracts';
import type {
  AppendChatBufferInput,
  ChatQueueBufferSnapshot,
  ChatQueueRecoveryOutcome,
  CompleteChatBufferInput,
} from './chat-queue-store.types';
import type { ChatQueueStorePort } from './chat-queue-store.port';
import { readChatFlushRetrySettings } from './chat-queue-retry.config';

const CHAT_QUEUE_BUFFER_TTL_SECONDS = 24 * 60 * 60;

interface RedisChatQueueBufferState {
  texts: string[];
  pendingTexts: string[];
  /** Claimed batch persisted in-flight — replayable after a worker crash (#176). */
  processingTexts: string[];
  userId?: number;
  context?: Record<string, unknown> | null;
  /** Messenger field retained so pre-#174 buffers survive the extraction. */
  linkContext?: Record<string, unknown> | null;
  lastIdempotencyKey?: string | null;
  lastPendingIdempotencyKey?: string | null;
  idempotencyKeys: string[];
  processing: boolean;
  processingStartedAt?: number | null;
  /** Fences completion/retry writes from a worker that lost its claim. */
  processingLeaseToken?: string | null;
  /** Idempotency key of the claimed batch, retained for retry/recovery. */
  processingIdempotencyKey?: string | null;
  /** Number of automatic retry/recovery attempts for the current batch. */
  retryCount: number;
  /** Failed batch is retained for operator-driven recovery after the cap. */
  abandoned?: boolean | null;
  flushAfterAt?: number | null;
  droppedNoticePending?: boolean | null;
  updatedAt: number;
}

export interface RedisChatQueueStoreOptions {
  platform?: Platform;
  /** Keep the original Messenger keys so existing buffers remain readable. */
  legacyKeys?: boolean;
  /** Bounded telemetry callback; failures must never affect queue behavior. */
  onRecoveryOutcome?: (outcome: ChatQueueRecoveryOutcome) => void;
}

@Injectable()
export class RedisChatQueueStore implements ChatQueueStorePort {
  private static readonly MAX_BUFFERED_MESSAGES = 20;
  private static readonly DEFAULT_LOCK_TTL_MS = 30_000;
  private static readonly DEFAULT_PROCESSING_STUCK_MS = 300_000;
  private static readonly REHYDRATE_LOCK_TTL_MS = 60_000;

  private readonly logger = new Logger(RedisChatQueueStore.name);
  private readonly lockTtlMs: number;
  private readonly stuckMs: number;
  private readonly bufferPrefix: string;
  private readonly lockPrefix: string;
  private readonly activeSet: string;
  private readonly flushSet: string;
  private readonly stuckSet: string;
  private readonly rehydrateLock: string;
  private readonly maxFlushRetries: number;
  private readonly onRecoveryOutcome?: (
    outcome: ChatQueueRecoveryOutcome,
  ) => void;

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redisClient: RedisClientPort,
    configService: ConfigService,
    options: RedisChatQueueStoreOptions = {},
  ) {
    const platform = options.platform ?? 'messenger';
    const legacyKeys = options.legacyKeys ?? platform === 'messenger';
    const prefix = legacyKeys ? 'chat:queue:' : `chat:queue:${platform}:`;
    this.bufferPrefix = `${prefix}buffer:`;
    this.lockPrefix = `${prefix}lock:`;
    this.activeSet = legacyKeys
      ? 'chat:queue:active-psids'
      : `${prefix}active-users`;
    this.flushSet = legacyKeys ? 'chat:queue:flush' : `${prefix}flush`;
    this.stuckSet = legacyKeys ? 'chat:queue:stuck' : `${prefix}stuck`;
    this.rehydrateLock = legacyKeys
      ? 'chat:queue:rehydrate-lock'
      : `${prefix}rehydrate-lock`;
    this.maxFlushRetries = readChatFlushRetrySettings(configService).maxRetries;
    this.onRecoveryOutcome = options.onRecoveryOutcome;

    const raw = configService.get<string>('CHAT_QUEUE_LOCK_TTL_MS');
    const parsed = raw ? Number(raw) : NaN;
    this.lockTtlMs =
      Number.isFinite(parsed) && parsed > 0
        ? Math.floor(parsed)
        : RedisChatQueueStore.DEFAULT_LOCK_TTL_MS;

    const stuckRaw = configService.get<string>(
      'CHAT_QUEUE_PROCESSING_STUCK_MS',
    );
    const stuckParsed = stuckRaw ? Number(stuckRaw) : NaN;
    this.stuckMs =
      Number.isFinite(stuckParsed) && stuckParsed > 0
        ? Math.floor(stuckParsed)
        : RedisChatQueueStore.DEFAULT_PROCESSING_STUCK_MS;
  }

  isAvailable(): boolean {
    return (
      this.redisClient.isEnabled() &&
      this.redisClient.getNativeClient() !== null
    );
  }

  async appendChatBuffer(input: AppendChatBufferInput): Promise<void> {
    await this.withExternalUserIdLock(
      input.externalUserId,
      async (client) => {
        const state = await this.readState(client, input.externalUserId);

        if (
          input.idempotencyKey &&
          state.idempotencyKeys.includes(input.idempotencyKey)
        ) {
          await client.sadd(this.activeSet, input.externalUserId);
          return;
        }

        if (input.idempotencyKey) {
          state.idempotencyKeys = [
            ...state.idempotencyKeys,
            input.idempotencyKey,
          ].slice(-RedisChatQueueStore.MAX_BUFFERED_MESSAGES * 2);
        }

        // A new user message makes an abandoned batch eligible for a fresh,
        // bounded attempt. The old text remains in the same durable buffer.
        if (state.abandoned) {
          state.abandoned = false;
          state.retryCount = 0;
        }

        const flushAfterAt = Date.now() + input.debounceMs;

        if (state.processing) {
          state.pendingTexts.push(input.userText);
          if (
            state.pendingTexts.length >
            RedisChatQueueStore.MAX_BUFFERED_MESSAGES
          ) {
            state.pendingTexts = state.pendingTexts.slice(
              -RedisChatQueueStore.MAX_BUFFERED_MESSAGES,
            );
            state.droppedNoticePending = true;
          }
          if (input.idempotencyKey) {
            state.lastPendingIdempotencyKey = input.idempotencyKey;
          }
        } else {
          state.texts.push(input.userText);
          if (state.texts.length > RedisChatQueueStore.MAX_BUFFERED_MESSAGES) {
            state.texts = state.texts.slice(
              -RedisChatQueueStore.MAX_BUFFERED_MESSAGES,
            );
            state.droppedNoticePending = true;
          }
          if (input.idempotencyKey) {
            state.lastIdempotencyKey = input.idempotencyKey;
          }
          state.flushAfterAt = flushAfterAt;
        }

        if (input.userId !== undefined) {
          state.userId = input.userId;
        }

        if (input.context !== undefined) {
          state.context = input.context;
        }

        state.updatedAt = Date.now();
        await this.writeState(client, input.externalUserId, state);
      },
      true,
    );
  }

  async claimReadyBuffer(
    externalUserId: string,
    _debounceMs: number,
    processingStuckMs: number,
  ): Promise<ChatQueueBufferSnapshot | null> {
    void _debounceMs;

    return this.withExternalUserIdLock(externalUserId, async (client) => {
      const state = await this.readState(client, externalUserId);

      if (state.processing) {
        const startedAt = state.processingStartedAt ?? 0;
        const stuck =
          startedAt > 0 && Date.now() - startedAt >= processingStuckMs;

        if (!stuck) {
          return null;
        }

        const replay = [...state.processingTexts, ...state.pendingTexts];
        const replayIdempotencyKey =
          state.lastPendingIdempotencyKey ??
          state.processingIdempotencyKey ??
          state.lastIdempotencyKey ??
          null;
        const retryCount = (state.retryCount ?? 0) + 1;

        // Crash recovery (#176): a pod died mid-flush with the claimed batch
        // persisted in processingTexts. Replay the claimed batch FIRST (it
        // was claimed earlier), then messages accumulated while stuck — no
        // accepted message is ever lost. Once the bounded budget is exhausted,
        // retain the batch as an abandoned durable record instead of deleting
        // it or putting it back on the automatic retry set.
        state.processing = false;
        state.processingStartedAt = null;
        state.processingLeaseToken = null;
        state.processingIdempotencyKey = null;
        state.processingTexts = [];
        state.pendingTexts = [];
        if (replay.length > 0) {
          if (retryCount > this.maxFlushRetries) {
            state.texts = replay;
            state.lastIdempotencyKey = replayIdempotencyKey;
            state.lastPendingIdempotencyKey = null;
            state.retryCount = retryCount;
            state.flushAfterAt = null;
            state.abandoned = true;
            await this.writeState(client, externalUserId, state);
            this.recordRecoveryOutcome('abandoned');
            return null;
          }
          state.texts = replay;
          state.lastIdempotencyKey = replayIdempotencyKey;
          state.lastPendingIdempotencyKey = null;
          state.retryCount = retryCount;
          state.abandoned = false;
          // Claim immediately — the stuck job already consumed the debounce wait.
          state.flushAfterAt = Date.now();
          this.recordRecoveryOutcome('durable_recovery');
        } else {
          // Wedged with nothing to replay: persist the reset so the dead
          // member leaves the flush/stuck ZSETs instead of being re-picked
          // by every poll until the buffer key expires.
          await this.writeState(client, externalUserId, state);
          return null;
        }
      }

      if (state.texts.length === 0) {
        return null;
      }

      if (
        state.flushAfterAt !== null &&
        state.flushAfterAt !== undefined &&
        state.flushAfterAt > Date.now()
      ) {
        return null;
      }

      const leaseToken = randomUUID();
      const snapshot: ChatQueueBufferSnapshot = {
        externalUserId,
        texts: [...state.texts],
        leaseToken,
        lastIdempotencyKey: state.lastIdempotencyKey ?? undefined,
        retryCount: state.retryCount ?? 0,
        userId: state.userId,
        context: state.context ?? undefined,
        droppedNoticePending: state.droppedNoticePending === true,
      };

      // Persist the claimed batch as recoverable in-flight state (#176): it
      // stays in processingTexts until completeChatBuffer — a crash between
      // claim and completion replays it instead of losing it.
      state.processingTexts = [...state.texts];
      state.texts = [];
      state.processingIdempotencyKey = state.lastIdempotencyKey ?? null;
      state.lastIdempotencyKey = null;
      state.processing = true;
      state.processingStartedAt = Date.now();
      state.processingLeaseToken = leaseToken;
      state.updatedAt = Date.now();

      await this.writeState(client, externalUserId, state);
      return snapshot;
    });
  }

  async scheduleRetryFlush(
    externalUserId: string,
    retryDelayMs: number,
    leaseToken: string,
  ): Promise<boolean> {
    return (
      (await this.withExternalUserIdLock(externalUserId, async (client) => {
        const state = await this.readState(client, externalUserId);

        if (!state.processing || state.processingLeaseToken !== leaseToken) {
          this.recordRecoveryOutcome('fenced_stale');
          return false;
        }

        const retryTexts = [...state.processingTexts, ...state.pendingTexts];
        if (retryTexts.length === 0) {
          return false;
        }

        const retryIdempotencyKey =
          state.lastPendingIdempotencyKey ??
          state.processingIdempotencyKey ??
          state.lastIdempotencyKey ??
          null;
        const retryCount = (state.retryCount ?? 0) + 1;
        if (retryCount > this.maxFlushRetries) {
          this.resetToReady(state, retryTexts, null);
          state.lastIdempotencyKey = retryIdempotencyKey;
          state.lastPendingIdempotencyKey = null;
          state.retryCount = retryCount;
          state.abandoned = true;
          await this.writeState(client, externalUserId, state);
          this.recordRecoveryOutcome('abandoned');
          return false;
        }

        this.resetToReady(state, retryTexts, Date.now() + retryDelayMs);
        state.lastIdempotencyKey = retryIdempotencyKey;
        state.lastPendingIdempotencyKey = null;
        state.retryCount = retryCount;
        state.abandoned = false;
        await this.writeState(client, externalUserId, state);
        this.recordRecoveryOutcome('retry');
        return true;
      })) ?? false
    );
  }

  async completeChatBuffer(input: CompleteChatBufferInput): Promise<boolean> {
    return (
      (await this.withExternalUserIdLock(
        input.externalUserId,
        async (client) => {
          const state = await this.readState(client, input.externalUserId);
          if (
            !state.processing ||
            state.processingLeaseToken !== input.leaseToken
          ) {
            this.recordRecoveryOutcome('fenced_stale');
            return false;
          }
          const pendingTexts = [...state.pendingTexts];
          const flushAfterAt =
            pendingTexts.length > 0 ? Date.now() + input.debounceMs : null;

          this.resetToReady(state, pendingTexts, flushAfterAt);
          state.lastIdempotencyKey = state.lastPendingIdempotencyKey ?? null;
          state.lastPendingIdempotencyKey = null;
          state.retryCount = 0;
          state.abandoned = false;
          state.droppedNoticePending = null;

          await this.writeState(client, input.externalUserId, state);
          return pendingTexts.length > 0;
        },
      )) ?? false
    );
  }

  async clearChatBuffer(externalUserId: string): Promise<boolean> {
    return (
      (await this.withExternalUserIdLock(externalUserId, async (client) => {
        const deleted = await client.del(this.bufferKey(externalUserId));
        await client.srem(this.activeSet, externalUserId);
        await client.zrem(this.flushSet, externalUserId);
        await client.zrem(this.stuckSet, externalUserId);
        return deleted > 0;
      })) ?? false
    );
  }

  async listReadyExternalUserIds(limit: number): Promise<string[]> {
    const client = this.redisClient.getNativeClient();
    if (!client) {
      return [];
    }

    try {
      // One-time backfill of pre-ZSET active members (buffer keys expire after
      // a day, so a missed member only loses a still-pending message).
      await this.maybeRehydrate(client);

      const now = Date.now();
      // Bounded poll: two ordered range reads, never a full-set scan.
      const [flushEntries, stuckEntries] = await Promise.all([
        client.zrangebyscore(
          this.flushSet,
          0,
          now,
          'WITHSCORES',
          'LIMIT',
          0,
          limit,
        ),
        client.zrangebyscore(
          this.stuckSet,
          0,
          now,
          'WITHSCORES',
          'LIMIT',
          0,
          limit,
        ),
      ]);

      const ready: string[] = [];
      for (const externalUserId of this.mergeCandidates(
        flushEntries,
        stuckEntries,
        limit,
      )) {
        // Buffer key expired (crash left no final writeState): drop every
        // membership so the 2s poll stops re-picking a dead member.
        const keyExists = await client.exists(this.bufferKey(externalUserId));
        if (!keyExists) {
          await this.removeStaleActiveMember(client, externalUserId);
          continue;
        }
        ready.push(externalUserId);
        if (ready.length >= limit) {
          break;
        }
      }

      return ready;
    } catch (error) {
      this.logger.error(
        `Redis queue list ready failed — messages may be delayed: ${errorMessage(
          error,
        )}`,
      );
      throw error;
    }
  }

  private async withExternalUserIdLock<T>(
    externalUserId: string,
    fn: (client: Redis) => Promise<T>,
    failOnError = false,
  ): Promise<T | null> {
    const client = this.redisClient.getNativeClient();
    if (!client) {
      if (failOnError) {
        throw new Error('Redis chat queue unavailable');
      }
      return null;
    }

    const lockKey = `${this.lockPrefix}${externalUserId}`;
    const lockValue = randomUUID();
    const acquired = await client.set(
      lockKey,
      lockValue,
      'PX',
      this.lockTtlMs,
      'NX',
    );

    if (acquired !== 'OK') {
      if (failOnError) {
        throw new Error(
          `Redis chat queue lock busy for externalUserId=${maskExternalId(externalUserId)}`,
        );
      }
      return null;
    }

    let operationFailed = false;
    let operationError: unknown;
    let result: T | null = null;

    try {
      result = await fn(client);
    } catch (error) {
      operationFailed = true;
      operationError = error;
      this.logger.warn(
        `Redis queue operation failed externalUserId=${maskExternalId(
          externalUserId,
        )}: ${errorMessage(error)}`,
      );
    }

    try {
      await this.releaseLock(client, lockKey, lockValue);
    } catch (error) {
      this.logger.error(
        `Redis queue lock release failed externalUserId=${maskExternalId(
          externalUserId,
        )}: ${errorMessage(error)}`,
      );
      if (!operationFailed) {
        throw error;
      }
    }

    if (operationFailed && failOnError) {
      throw operationError;
    }

    return result;
  }

  private async releaseLock(
    client: Redis,
    lockKey: string,
    lockValue: string,
  ): Promise<void> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `;

    await client.eval(script, 1, lockKey, lockValue);
  }

  private async removeStaleActiveMember(
    client: Redis,
    externalUserId: string,
  ): Promise<void> {
    const script = `
      if redis.call("exists", KEYS[1]) == 0 then
        redis.call("srem", KEYS[2], ARGV[1])
        redis.call("zrem", KEYS[3], ARGV[1])
        redis.call("zrem", KEYS[4], ARGV[1])
        return 1
      end
      return 0
    `;

    await client.eval(
      script,
      4,
      this.bufferKey(externalUserId),
      this.activeSet,
      this.flushSet,
      this.stuckSet,
      externalUserId,
    );
  }

  /**
   * Backfill for the pre-ZSET era: when both ready ZSETs are empty but the
   * legacy active set still has members, one pod (guarded by a short Redis
   * lock) scans the set once and repopulates the ZSETs. Idempotent — members
   * with no buffered work are dropped via the stale-member script.
   */
  private async maybeRehydrate(client: Redis): Promise<void> {
    const flushCount = await client.zcard(this.flushSet);
    const stuckCount = await client.zcard(this.stuckSet);
    if (flushCount + stuckCount > 0) {
      return;
    }

    const activeCount = await client.scard(this.activeSet);
    if (activeCount === 0) {
      return;
    }

    const lockValue = randomUUID();
    const acquired = await client.set(
      this.rehydrateLock,
      lockValue,
      'PX',
      RedisChatQueueStore.REHYDRATE_LOCK_TTL_MS,
      'NX',
    );
    if (acquired !== 'OK') {
      return; // another pod is rehydrating — skip this tick
    }

    try {
      const psids = await client.smembers(this.activeSet);
      for (const externalUserId of psids) {
        const state = await this.readState(client, externalUserId);
        if (state.abandoned) {
          // Retained dead-letter state is intentionally not scheduled until a
          // new message or an operator explicitly requeues it.
          continue;
        }
        if (state.processing) {
          const stuckAt =
            (state.processingStartedAt ?? Date.now()) + this.stuckMs;
          await client.zadd(this.stuckSet, stuckAt, externalUserId);
        } else if (
          state.texts.length > 0 &&
          state.flushAfterAt !== null &&
          state.flushAfterAt !== undefined
        ) {
          await client.zadd(this.flushSet, state.flushAfterAt, externalUserId);
        } else {
          await this.removeStaleActiveMember(client, externalUserId);
        }
      }
    } finally {
      await client.del(this.rehydrateLock);
    }
  }

  /** Merge both ZSET reads, dedupe, sort by due time, cap at the limit. */
  private mergeCandidates(
    flushEntries: string[],
    stuckEntries: string[],
    limit: number,
  ): string[] {
    const seen = new Set<string>();
    const entries: Array<{ externalUserId: string; score: number }> = [];

    const push = (raw: string[]): void => {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const externalUserId = raw[i];
        if (externalUserId === undefined || seen.has(externalUserId)) {
          continue;
        }
        seen.add(externalUserId);
        entries.push({ externalUserId, score: Number(raw[i + 1]) });
      }
    };

    push(flushEntries);
    push(stuckEntries);

    return entries
      .sort((left, right) => left.score - right.score)
      .slice(0, limit)
      .map((entry) => entry.externalUserId);
  }

  private resetToReady(
    state: RedisChatQueueBufferState,
    texts: string[],
    flushAfterAt: number | null,
  ): void {
    state.processing = false;
    state.processingStartedAt = null;
    state.processingLeaseToken = null;
    state.processingIdempotencyKey = null;
    state.processingTexts = [];
    state.texts = texts;
    state.pendingTexts = [];
    state.flushAfterAt = flushAfterAt;
    state.updatedAt = Date.now();
  }

  private bufferKey(externalUserId: string): string {
    return `${this.bufferPrefix}${externalUserId}`;
  }

  private emptyState(): RedisChatQueueBufferState {
    return {
      texts: [],
      pendingTexts: [],
      processingTexts: [],
      processing: false,
      processingStartedAt: null,
      processingLeaseToken: null,
      processingIdempotencyKey: null,
      retryCount: 0,
      abandoned: false,
      flushAfterAt: null,
      context: null,
      lastIdempotencyKey: null,
      lastPendingIdempotencyKey: null,
      idempotencyKeys: [],
      droppedNoticePending: null,
      updatedAt: Date.now(),
    };
  }

  private async readState(
    client: Redis,
    externalUserId: string,
  ): Promise<RedisChatQueueBufferState> {
    const raw = await client.get(this.bufferKey(externalUserId));
    if (!raw) {
      return this.emptyState();
    }

    try {
      const parsed = JSON.parse(raw) as RedisChatQueueBufferState;
      const legacyIdempotencyKeys = [
        parsed.lastIdempotencyKey,
        parsed.lastPendingIdempotencyKey,
      ].filter((key): key is string => typeof key === 'string');
      return {
        ...this.emptyState(),
        ...parsed,
        context: parsed.context ?? parsed.linkContext ?? null,
        texts: Array.isArray(parsed.texts) ? parsed.texts : [],
        pendingTexts: Array.isArray(parsed.pendingTexts)
          ? parsed.pendingTexts
          : [],
        processingTexts: Array.isArray(parsed.processingTexts)
          ? parsed.processingTexts
          : [],
        retryCount:
          typeof parsed.retryCount === 'number' && parsed.retryCount >= 0
            ? Math.floor(parsed.retryCount)
            : 0,
        abandoned: parsed.abandoned === true,
        idempotencyKeys: Array.isArray(parsed.idempotencyKeys)
          ? parsed.idempotencyKeys
          : legacyIdempotencyKeys,
      };
    } catch {
      return this.emptyState();
    }
  }

  private async writeState(
    client: Redis,
    externalUserId: string,
    state: RedisChatQueueBufferState,
  ): Promise<void> {
    const key = this.bufferKey(externalUserId);
    const hasBufferedWork =
      state.texts.length > 0 ||
      state.pendingTexts.length > 0 ||
      state.processingTexts.length > 0 ||
      state.processing;

    if (!hasBufferedWork) {
      const result = await client
        .multi()
        .del(key)
        .srem(this.activeSet, externalUserId)
        .zrem(this.flushSet, externalUserId)
        .zrem(this.stuckSet, externalUserId)
        .exec();
      this.assertTransactionSucceeded(result);
      return;
    }

    // ZSET membership mirrors the state: processing members wait in the
    // stuck set (score = when they become stuck), idle members with texts
    // wait in the flush set (score = debounce deadline).
    const multi = client
      .multi()
      .set(key, JSON.stringify(state), 'EX', CHAT_QUEUE_BUFFER_TTL_SECONDS)
      .sadd(this.activeSet, externalUserId);

    if (state.abandoned) {
      multi
        .zrem(this.flushSet, externalUserId)
        .zrem(this.stuckSet, externalUserId);
    } else if (state.processing) {
      const stuckAt = (state.processingStartedAt ?? Date.now()) + this.stuckMs;
      multi
        .zrem(this.flushSet, externalUserId)
        .zadd(this.stuckSet, stuckAt, externalUserId);
    } else {
      const flushAfterAt = state.flushAfterAt ?? Date.now();
      multi
        .zadd(this.flushSet, flushAfterAt, externalUserId)
        .zrem(this.stuckSet, externalUserId);
    }

    const result = await multi.exec();
    this.assertTransactionSucceeded(result);
  }

  private recordRecoveryOutcome(outcome: ChatQueueRecoveryOutcome): void {
    try {
      this.onRecoveryOutcome?.(outcome);
    } catch {
      // Recovery telemetry must never change queue state transitions.
    }
  }

  private assertTransactionSucceeded(
    result: Array<[Error | null, unknown]> | null,
  ): void {
    if (!result) {
      throw new Error('Redis queue transaction aborted');
    }

    const commandError = result.find(([error]) => error)?.[0];
    if (commandError) {
      throw commandError;
    }
  }
}
