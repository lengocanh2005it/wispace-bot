import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import {
  errorMessage,
  maskExternalId,
  REDIS_CLIENT,
} from '@wispace/bot-common';
import type { RedisClientPort } from '@wispace/bot-common';
import type { MessengerLinkContext } from '@messenger/shared/config/poc.constants';
import { CHAT_QUEUE_BUFFER_TTL_SECONDS } from '../../domain/entities/messenger-store.types';
import type {
  AppendChatBufferInput,
  ChatQueueBufferSnapshot,
  CompleteChatBufferInput,
} from '../../domain/entities/chat-shared-state.types';
import type { ChatQueueStorePort } from '../../domain/repositories/chat-queue.store.port';

interface RedisChatQueueBufferState {
  texts: string[];
  pendingTexts: string[];
  userId?: number;
  linkContext?: MessengerLinkContext | null;
  lastIdempotencyKey?: string | null;
  lastPendingIdempotencyKey?: string | null;
  idempotencyKeys: string[];
  processing: boolean;
  processingStartedAt?: number | null;
  flushAfterAt?: number | null;
  droppedNoticePending?: boolean | null;
  updatedAt: number;
}

@Injectable()
export class RedisChatQueueStore implements ChatQueueStorePort {
  private static readonly MAX_BUFFERED_MESSAGES = 20;
  private static readonly BUFFER_PREFIX = 'chat:queue:buffer:';
  private static readonly LOCK_PREFIX = 'chat:queue:lock:';
  private static readonly ACTIVE_SET = 'chat:queue:active-psids';
  /** Ready-to-flush members keyed by flushAfterAt (debounce deadline). */
  private static readonly FLUSH_SET = 'chat:queue:flush';
  /** Processing members keyed by the time they become stuck (start + stuckMs). */
  private static readonly STUCK_SET = 'chat:queue:stuck';
  private static readonly REHYDRATE_LOCK = 'chat:queue:rehydrate-lock';
  private static readonly DEFAULT_LOCK_TTL_MS = 30_000;
  private static readonly DEFAULT_PROCESSING_STUCK_MS = 300_000;
  private static readonly REHYDRATE_LOCK_TTL_MS = 60_000;

  private readonly logger = new Logger(RedisChatQueueStore.name);
  private readonly lockTtlMs: number;
  private readonly stuckMs: number;

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redisClient: RedisClientPort,
    configService: ConfigService,
  ) {
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
    await this.withPsidLock(
      input.psid,
      async (client) => {
        const state = await this.readState(client, input.psid);

        if (
          input.idempotencyKey &&
          state.idempotencyKeys.includes(input.idempotencyKey)
        ) {
          await client.sadd(RedisChatQueueStore.ACTIVE_SET, input.psid);
          return;
        }

        if (input.idempotencyKey) {
          state.idempotencyKeys = [
            ...state.idempotencyKeys,
            input.idempotencyKey,
          ].slice(-RedisChatQueueStore.MAX_BUFFERED_MESSAGES * 2);
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

        if (input.linkContext !== undefined) {
          state.linkContext = input.linkContext;
        }

        state.updatedAt = Date.now();
        await this.writeState(client, input.psid, state);
      },
      true,
    );
  }

  async claimReadyBuffer(
    psid: string,
    _debounceMs: number,
    processingStuckMs: number,
  ): Promise<ChatQueueBufferSnapshot | null> {
    void _debounceMs;

    return this.withPsidLock(psid, async (client) => {
      const state = await this.readState(client, psid);

      if (state.processing) {
        const startedAt = state.processingStartedAt ?? 0;
        const stuck =
          startedAt > 0 && Date.now() - startedAt >= processingStuckMs;

        if (!stuck) {
          return null;
        }

        // Crash recovery: a pod died mid-flush leaving texts=[], processing=true.
        // Reset the flag and promote messages accumulated while it was stuck.
        state.processing = false;
        state.processingStartedAt = null;

        if (state.pendingTexts.length > 0) {
          state.texts = [...state.pendingTexts];
          state.pendingTexts = [];
          state.lastIdempotencyKey = state.lastPendingIdempotencyKey ?? null;
          state.lastPendingIdempotencyKey = null;
          // Claim immediately — the stuck job already consumed the debounce wait.
          state.flushAfterAt = Date.now();
        } else {
          // Wedged with no pending messages: persist the reset so the dead
          // member leaves the flush/stuck ZSETs instead of being re-picked
          // by every poll until the buffer key expires.
          await this.writeState(client, psid, state);
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

      const snapshot: ChatQueueBufferSnapshot = {
        psid,
        texts: [...state.texts],
        lastIdempotencyKey: state.lastIdempotencyKey ?? undefined,
        userId: state.userId,
        linkContext: state.linkContext ?? undefined,
        droppedNoticePending: state.droppedNoticePending === true,
      };

      state.texts = [];
      state.lastIdempotencyKey = null;
      state.processing = true;
      state.processingStartedAt = Date.now();
      state.updatedAt = Date.now();

      await this.writeState(client, psid, state);
      return snapshot;
    });
  }

  async completeChatBuffer(input: CompleteChatBufferInput): Promise<boolean> {
    return (
      (await this.withPsidLock(input.psid, async (client) => {
        const state = await this.readState(client, input.psid);
        const pendingTexts = [...state.pendingTexts];
        const flushAfterAt =
          pendingTexts.length > 0 ? Date.now() + input.debounceMs : null;

        state.processing = false;
        state.processingStartedAt = null;
        state.texts = pendingTexts;
        state.pendingTexts = [];
        state.lastIdempotencyKey = state.lastPendingIdempotencyKey ?? null;
        state.lastPendingIdempotencyKey = null;
        state.flushAfterAt = flushAfterAt;
        state.droppedNoticePending = null;
        state.updatedAt = Date.now();

        await this.writeState(client, input.psid, state);
        return pendingTexts.length > 0;
      })) ?? false
    );
  }

  async listPsidsReadyForFlush(limit: number): Promise<string[]> {
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
          RedisChatQueueStore.FLUSH_SET,
          0,
          now,
          'WITHSCORES',
          'LIMIT',
          0,
          limit,
        ),
        client.zrangebyscore(
          RedisChatQueueStore.STUCK_SET,
          0,
          now,
          'WITHSCORES',
          'LIMIT',
          0,
          limit,
        ),
      ]);

      const ready: string[] = [];
      for (const psid of this.mergeCandidates(
        flushEntries,
        stuckEntries,
        limit,
      )) {
        // Buffer key expired (crash left no final writeState): drop every
        // membership so the 2s poll stops re-picking a dead member.
        const keyExists = await client.exists(this.bufferKey(psid));
        if (!keyExists) {
          await this.removeStaleActiveMember(client, psid);
          continue;
        }
        ready.push(psid);
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

  private async withPsidLock<T>(
    psid: string,
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

    const lockKey = `${RedisChatQueueStore.LOCK_PREFIX}${psid}`;
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
          `Redis chat queue lock busy for psid=${maskExternalId(psid)}`,
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
        `Redis queue operation failed psid=${maskExternalId(
          psid,
        )}: ${errorMessage(error)}`,
      );
    }

    try {
      await this.releaseLock(client, lockKey, lockValue);
    } catch (error) {
      this.logger.error(
        `Redis queue lock release failed psid=${maskExternalId(
          psid,
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
    psid: string,
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
      this.bufferKey(psid),
      RedisChatQueueStore.ACTIVE_SET,
      RedisChatQueueStore.FLUSH_SET,
      RedisChatQueueStore.STUCK_SET,
      psid,
    );
  }

  /**
   * Backfill for the pre-ZSET era: when both ready ZSETs are empty but the
   * legacy active set still has members, one pod (guarded by a short Redis
   * lock) scans the set once and repopulates the ZSETs. Idempotent — members
   * with no buffered work are dropped via the stale-member script.
   */
  private async maybeRehydrate(client: Redis): Promise<void> {
    const flushCount = await client.zcard(RedisChatQueueStore.FLUSH_SET);
    const stuckCount = await client.zcard(RedisChatQueueStore.STUCK_SET);
    if (flushCount + stuckCount > 0) {
      return;
    }

    const activeCount = await client.scard(RedisChatQueueStore.ACTIVE_SET);
    if (activeCount === 0) {
      return;
    }

    const lockValue = randomUUID();
    const acquired = await client.set(
      RedisChatQueueStore.REHYDRATE_LOCK,
      lockValue,
      'PX',
      RedisChatQueueStore.REHYDRATE_LOCK_TTL_MS,
      'NX',
    );
    if (acquired !== 'OK') {
      return; // another pod is rehydrating — skip this tick
    }

    try {
      const psids = await client.smembers(RedisChatQueueStore.ACTIVE_SET);
      for (const psid of psids) {
        const state = await this.readState(client, psid);
        if (state.processing) {
          const stuckAt =
            (state.processingStartedAt ?? Date.now()) + this.stuckMs;
          await client.zadd(RedisChatQueueStore.STUCK_SET, stuckAt, psid);
        } else if (
          state.texts.length > 0 &&
          state.flushAfterAt !== null &&
          state.flushAfterAt !== undefined
        ) {
          await client.zadd(
            RedisChatQueueStore.FLUSH_SET,
            state.flushAfterAt,
            psid,
          );
        } else {
          await this.removeStaleActiveMember(client, psid);
        }
      }
    } finally {
      await client.del(RedisChatQueueStore.REHYDRATE_LOCK);
    }
  }

  /** Merge both ZSET reads, dedupe, sort by due time, cap at the limit. */
  private mergeCandidates(
    flushEntries: string[],
    stuckEntries: string[],
    limit: number,
  ): string[] {
    const seen = new Set<string>();
    const entries: Array<{ psid: string; score: number }> = [];

    const push = (raw: string[]): void => {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const psid = raw[i];
        if (psid === undefined || seen.has(psid)) {
          continue;
        }
        seen.add(psid);
        entries.push({ psid, score: Number(raw[i + 1]) });
      }
    };

    push(flushEntries);
    push(stuckEntries);

    return entries
      .sort((left, right) => left.score - right.score)
      .slice(0, limit)
      .map((entry) => entry.psid);
  }

  private bufferKey(psid: string): string {
    return `${RedisChatQueueStore.BUFFER_PREFIX}${psid}`;
  }

  private emptyState(): RedisChatQueueBufferState {
    return {
      texts: [],
      pendingTexts: [],
      processing: false,
      processingStartedAt: null,
      flushAfterAt: null,
      linkContext: null,
      lastIdempotencyKey: null,
      lastPendingIdempotencyKey: null,
      idempotencyKeys: [],
      droppedNoticePending: null,
      updatedAt: Date.now(),
    };
  }

  private async readState(
    client: Redis,
    psid: string,
  ): Promise<RedisChatQueueBufferState> {
    const raw = await client.get(this.bufferKey(psid));
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
        texts: Array.isArray(parsed.texts) ? parsed.texts : [],
        pendingTexts: Array.isArray(parsed.pendingTexts)
          ? parsed.pendingTexts
          : [],
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
    psid: string,
    state: RedisChatQueueBufferState,
  ): Promise<void> {
    const key = this.bufferKey(psid);
    const hasBufferedWork =
      state.texts.length > 0 ||
      state.pendingTexts.length > 0 ||
      state.processing;

    if (!hasBufferedWork) {
      const result = await client
        .multi()
        .del(key)
        .srem(RedisChatQueueStore.ACTIVE_SET, psid)
        .zrem(RedisChatQueueStore.FLUSH_SET, psid)
        .zrem(RedisChatQueueStore.STUCK_SET, psid)
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
      .sadd(RedisChatQueueStore.ACTIVE_SET, psid);

    if (state.processing) {
      const stuckAt = (state.processingStartedAt ?? Date.now()) + this.stuckMs;
      multi
        .zrem(RedisChatQueueStore.FLUSH_SET, psid)
        .zadd(RedisChatQueueStore.STUCK_SET, stuckAt, psid);
    } else {
      const flushAfterAt = state.flushAfterAt ?? Date.now();
      multi
        .zadd(RedisChatQueueStore.FLUSH_SET, flushAfterAt, psid)
        .zrem(RedisChatQueueStore.STUCK_SET, psid);
    }

    const result = await multi.exec();
    this.assertTransactionSucceeded(result);
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
