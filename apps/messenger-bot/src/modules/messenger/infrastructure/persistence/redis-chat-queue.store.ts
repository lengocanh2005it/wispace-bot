import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '@wispace/bot-common';
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
  processing: boolean;
  processingStartedAt?: number | null;
  flushAfterAt?: number | null;
  updatedAt: number;
}

@Injectable()
export class RedisChatQueueStore implements ChatQueueStorePort {
  private static readonly BUFFER_PREFIX = 'chat:queue:buffer:';
  private static readonly LOCK_PREFIX = 'chat:queue:lock:';
  private static readonly ACTIVE_SET = 'chat:queue:active-psids';
  private static readonly LOCK_TTL_MS = 5_000;

  private readonly logger = new Logger(RedisChatQueueStore.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redisClient: RedisClientPort,
  ) {}

  isAvailable(): boolean {
    return (
      this.redisClient.isEnabled() &&
      this.redisClient.getNativeClient() !== null
    );
  }

  async appendChatBuffer(input: AppendChatBufferInput): Promise<void> {
    await this.withPsidLock(input.psid, async (client) => {
      const state = await this.readState(client, input.psid);
      const flushAfterAt = Date.now() + input.debounceMs;

      if (state.processing) {
        state.pendingTexts.push(input.userText);
        if (input.idempotencyKey) {
          state.lastPendingIdempotencyKey = input.idempotencyKey;
        }
      } else {
        state.texts.push(input.userText);
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
    });
  }

  async claimReadyBuffer(
    psid: string,
    _debounceMs: number,
    processingStuckMs: number,
  ): Promise<ChatQueueBufferSnapshot | null> {
    void _debounceMs;

    return this.withPsidLock(psid, async (client) => {
      const state = await this.readState(client, psid);
      if (state.texts.length === 0) {
        return null;
      }

      if (state.processing) {
        const startedAt = state.processingStartedAt ?? 0;
        const stuck =
          startedAt > 0 && Date.now() - startedAt >= processingStuckMs;

        if (!stuck) {
          return null;
        }

        state.processing = false;
        state.processingStartedAt = null;
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
        const state = await this.readState(client, psid);
        if (state.texts.length === 0) {
          continue;
        }

        const flushReady =
          !state.processing &&
          state.flushAfterAt !== null &&
          state.flushAfterAt !== undefined &&
          state.flushAfterAt <= Date.now();

        const stuckProcessing =
          state.processing &&
          state.processingStartedAt !== null &&
          state.processingStartedAt !== undefined &&
          Date.now() - state.processingStartedAt >= processingStuckMs;

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
      this.logger.warn(
        `Redis queue list ready failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  private async withPsidLock<T>(
    psid: string,
    fn: (client: Redis) => Promise<T>,
  ): Promise<T | null> {
    const client = this.redisClient.getNativeClient();
    if (!client) {
      return null;
    }

    const lockKey = `${RedisChatQueueStore.LOCK_PREFIX}${psid}`;
    const lockValue = randomUUID();
    const acquired = await client.set(
      lockKey,
      lockValue,
      'PX',
      RedisChatQueueStore.LOCK_TTL_MS,
      'NX',
    );

    if (acquired !== 'OK') {
      return null;
    }

    try {
      return await fn(client);
    } catch (error) {
      this.logger.warn(
        `Redis queue operation failed psid=${psid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    } finally {
      await this.releaseLock(client, lockKey, lockValue);
    }
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
      return {
        ...this.emptyState(),
        ...parsed,
        texts: Array.isArray(parsed.texts) ? parsed.texts : [],
        pendingTexts: Array.isArray(parsed.pendingTexts)
          ? parsed.pendingTexts
          : [],
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
      await client.del(key);
      await client.srem(RedisChatQueueStore.ACTIVE_SET, psid);
      return;
    }

    await client.set(
      key,
      JSON.stringify(state),
      'EX',
      CHAT_QUEUE_BUFFER_TTL_SECONDS,
    );
    await client.sadd(RedisChatQueueStore.ACTIVE_SET, psid);
  }
}
