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
  updatedAt: number;
}

@Injectable()
export class RedisChatQueueStore implements ChatQueueStorePort {
  private static readonly MAX_BUFFERED_MESSAGES = 20;
  private static readonly BUFFER_PREFIX = 'chat:queue:buffer:';
  private static readonly LOCK_PREFIX = 'chat:queue:lock:';
  private static readonly ACTIVE_SET = 'chat:queue:active-psids';
  private static readonly DEFAULT_LOCK_TTL_MS = 30_000;

  private readonly logger = new Logger(RedisChatQueueStore.name);
  private readonly lockTtlMs: number;

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
          state.pendingTexts = state.pendingTexts.slice(
            -RedisChatQueueStore.MAX_BUFFERED_MESSAGES,
          );
          if (input.idempotencyKey) {
            state.lastPendingIdempotencyKey = input.idempotencyKey;
          }
        } else {
          state.texts.push(input.userText);
          state.texts = state.texts.slice(
            -RedisChatQueueStore.MAX_BUFFERED_MESSAGES,
          );
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
        state.updatedAt = Date.now();

        await this.writeState(client, input.psid, state);
        return pendingTexts.length > 0;
      })) ?? false
    );
  }

  async listPsidsReadyForFlush(
    limit: number,
    processingStuckMs: number,
  ): Promise<string[]> {
    const client = this.redisClient.getNativeClient();
    if (!client) {
      return [];
    }

    try {
      const psids = await client.smembers(RedisChatQueueStore.ACTIVE_SET);
      const ready: Array<{ psid: string; flushAfterAt: number }> = [];

      for (const psid of psids) {
        // Buffer key expired (crash left no final writeState): drop the set
        // member so the 2s poll stops GET-ing a missing key forever.
        const keyExists = await client.exists(this.bufferKey(psid));
        if (!keyExists) {
          await this.removeStaleActiveMember(client, psid);
          continue;
        }

        const state = await this.readState(client, psid);

        const stuckProcessing =
          state.processing &&
          state.processingStartedAt !== null &&
          state.processingStartedAt !== undefined &&
          Date.now() - state.processingStartedAt >= processingStuckMs;

        // A wedged psid (processing=true, texts cleared by a crashed pod) is
        // ready too — claimReadyBuffer promotes pendingTexts on reset.
        if (state.texts.length === 0) {
          if (!stuckProcessing) {
            continue;
          }
          ready.push({
            psid,
            flushAfterAt: state.processingStartedAt ?? state.updatedAt,
          });
          continue;
        }

        const flushReady =
          !state.processing &&
          state.flushAfterAt !== null &&
          state.flushAfterAt !== undefined &&
          state.flushAfterAt <= Date.now();

        if (flushReady || stuckProcessing) {
          ready.push({
            psid,
            flushAfterAt: state.flushAfterAt ?? state.updatedAt,
          });
        }
      }

      return ready
        .sort((left, right) => left.flushAfterAt - right.flushAfterAt)
        .slice(0, limit)
        .map((entry) => entry.psid);
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
        return redis.call("srem", KEYS[2], ARGV[1])
      end
      return 0
    `;

    await client.eval(
      script,
      2,
      this.bufferKey(psid),
      RedisChatQueueStore.ACTIVE_SET,
      psid,
    );
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
        .exec();
      this.assertTransactionSucceeded(result);
      return;
    }

    const result = await client
      .multi()
      .set(key, JSON.stringify(state), 'EX', CHAT_QUEUE_BUFFER_TTL_SECONDS)
      .sadd(RedisChatQueueStore.ACTIVE_SET, psid)
      .exec();
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
