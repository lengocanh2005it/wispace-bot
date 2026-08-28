import type { RedisClientPort } from '@wispace/bot-common/redis';
import { RedisChatQueueStore } from './redis-chat-queue.store';

describe('RedisChatQueueStore', () => {
  const createStore = (
    client: Record<string, jest.Mock>,
    platform: 'messenger' | 'discord' | 'zalo' = 'messenger',
  ) =>
    new RedisChatQueueStore(
      {
        isEnabled: () => true,
        getNativeClient: () => client,
      } as unknown as RedisClientPort,
      { get: () => undefined } as never,
      { platform },
    );

  const createTransaction = () => {
    const transaction = {
      set: jest.fn(),
      sadd: jest.fn(),
      del: jest.fn(),
      srem: jest.fn(),
      zadd: jest.fn(),
      zrem: jest.fn(),
      exec: jest.fn().mockResolvedValue([
        [null, 'OK'],
        [null, 1],
      ]),
    };
    for (const method of [
      transaction.set,
      transaction.sadd,
      transaction.del,
      transaction.srem,
      transaction.zadd,
      transaction.zrem,
    ]) {
      method.mockReturnValue(transaction);
    }
    return transaction;
  };

  const createClient = (
    get: jest.Mock,
    transaction: ReturnType<typeof createTransaction>,
  ) => ({
    set: jest.fn().mockResolvedValue('OK'),
    get,
    eval: jest.fn().mockResolvedValue(1),
    sadd: jest.fn().mockResolvedValue(1),
    multi: jest.fn().mockReturnValue(transaction),
    zcard: jest.fn().mockResolvedValue(0),
    scard: jest.fn().mockResolvedValue(0),
    smembers: jest.fn().mockResolvedValue([]),
    zrangebyscore: jest.fn().mockResolvedValue([]),
    exists: jest.fn().mockResolvedValue(1),
  });

  it('keeps Messenger on its legacy namespace and isolates Discord', async () => {
    const transaction = createTransaction();
    const client = createClient(jest.fn().mockResolvedValue(null), transaction);

    await createStore(client).appendChatBuffer({
      externalUserId: 'discord-1',
      userText: 'hello',
      debounceMs: 2000,
    });

    expect(transaction.set).toHaveBeenCalledWith(
      'chat:queue:buffer:discord-1',
      expect.any(String),
      'EX',
      86_400,
    );

    transaction.set.mockClear();
    await createStore(client, 'discord').appendChatBuffer({
      externalUserId: 'discord-1',
      userText: 'hello',
      debounceMs: 2000,
    });

    expect(transaction.set).toHaveBeenCalledWith(
      'chat:queue:discord:buffer:discord-1',
      expect.any(String),
      'EX',
      86_400,
    );
  });

  it('replays a claimed batch after a fresh store instance takes over', async () => {
    let persistedState: string | null = JSON.stringify({
      texts: ['accepted'],
      pendingTexts: [],
      processingTexts: [],
      processing: false,
      processingStartedAt: null,
      flushAfterAt: Date.now() - 1,
      lastIdempotencyKey: 'mid-1',
      lastPendingIdempotencyKey: null,
      idempotencyKeys: ['mid-1'],
    });
    const transaction = createTransaction();
    transaction.set.mockImplementation((_key: string, value: string) => {
      persistedState = value;
      return transaction;
    });
    const client = createClient(
      jest.fn().mockImplementation(() => Promise.resolve(persistedState)),
      transaction,
    );

    const firstWorker = createStore(client, 'zalo');
    const claimed = await firstWorker.claimReadyBuffer('zalo-1', 2000, 300_000);
    expect(claimed?.texts).toEqual(['accepted']);

    const restartedWorker = createStore(client, 'zalo');
    const recovered = await restartedWorker.claimReadyBuffer('zalo-1', 2000, 0);

    expect(recovered?.texts).toEqual(['accepted']);
  });

  describe('scheduleRetryFlush', () => {
    it('moves processingTexts back to texts with flushAfterAt delay', async () => {
      let persistedState: string | null = JSON.stringify({
        texts: [],
        pendingTexts: [],
        processingTexts: ['hello', 'world'],
        processing: true,
        processingStartedAt: Date.now(),
        processingLeaseToken: 'lease-1',
        flushAfterAt: null,
        lastIdempotencyKey: 'mid-1',
        lastPendingIdempotencyKey: null,
        idempotencyKeys: ['mid-1'],
      });
      const transaction = createTransaction();
      transaction.set.mockImplementation((_key: string, value: string) => {
        persistedState = value;
        return transaction;
      });
      const client = createClient(
        jest.fn().mockImplementation(() => Promise.resolve(persistedState)),
        transaction,
      );
      const store = createStore(client, 'discord');

      const result = await store.scheduleRetryFlush(
        'discord-1',
        5000,
        'lease-1',
      );

      expect(result).toBe(true);
      const written = JSON.parse(persistedState ?? '{}') as {
        texts: string[];
        processingTexts: string[];
        processing: boolean;
        flushAfterAt: number | null;
      };
      expect(written.texts).toEqual(['hello', 'world']);
      expect(written.processingTexts).toEqual([]);
      expect(written.processing).toBe(false);
      expect(written.flushAfterAt).toBeGreaterThan(Date.now() - 1000);
      expect(written.flushAfterAt).toBeLessThanOrEqual(Date.now() + 5100);
    });

    it('no-ops when processingTexts is empty', async () => {
      const persistedState: string | null = JSON.stringify({
        texts: [],
        pendingTexts: [],
        processingTexts: [],
        processing: true,
        processingStartedAt: Date.now(),
        processingLeaseToken: 'lease-empty',
        flushAfterAt: null,
        lastIdempotencyKey: null,
        lastPendingIdempotencyKey: null,
        idempotencyKeys: [],
      });
      const transaction = createTransaction();
      const writeSpy = transaction.set;
      const client = createClient(
        jest.fn().mockImplementation(() => Promise.resolve(persistedState)),
        transaction,
      );
      const store = createStore(client, 'discord');

      const result = await store.scheduleRetryFlush(
        'discord-1',
        5000,
        'lease-empty',
      );

      expect(result).toBe(false);
      // No state write should happen when there's nothing to retry
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('includes pendingTexts in the retry batch', async () => {
      let persistedState: string | null = JSON.stringify({
        texts: [],
        pendingTexts: ['pending-msg'],
        processingTexts: ['claimed-msg'],
        processing: true,
        processingStartedAt: Date.now(),
        processingLeaseToken: 'lease-2',
        flushAfterAt: null,
        lastIdempotencyKey: 'mid-1',
        lastPendingIdempotencyKey: 'mid-2',
        idempotencyKeys: ['mid-1', 'mid-2'],
      });
      const transaction = createTransaction();
      transaction.set.mockImplementation((_key: string, value: string) => {
        persistedState = value;
        return transaction;
      });
      const client = createClient(
        jest.fn().mockImplementation(() => Promise.resolve(persistedState)),
        transaction,
      );
      const store = createStore(client, 'zalo');

      const result = await store.scheduleRetryFlush('zalo-1', 5000, 'lease-2');

      expect(result).toBe(true);
      const written = JSON.parse(persistedState ?? '{}') as {
        texts: string[];
        pendingTexts: string[];
        processingTexts: string[];
      };
      expect(written.texts).toEqual(['claimed-msg', 'pending-msg']);
      expect(written.pendingTexts).toEqual([]);
      expect(written.processingTexts).toEqual([]);
    });

    it('handles pipeline + fallback failure by scheduling retry and leaving texts ready for next claim', async () => {
      let persistedState: string | null = JSON.stringify({
        texts: ['batch-msg-1', 'batch-msg-2'],
        pendingTexts: [],
        processingTexts: [],
        processing: false,
        processingStartedAt: null,
        flushAfterAt: Date.now() - 1000,
        lastIdempotencyKey: 'mid-10',
      });
      const transaction = createTransaction();
      transaction.set.mockImplementation((_key: string, value: string) => {
        persistedState = value;
        return transaction;
      });
      const client = createClient(
        jest.fn().mockImplementation(() => Promise.resolve(persistedState)),
        transaction,
      );
      const store = createStore(client, 'discord');

      const claimed = await store.claimReadyBuffer(
        'discord-retry-1',
        2000,
        300_000,
      );
      expect(claimed?.texts).toEqual(['batch-msg-1', 'batch-msg-2']);

      const inFlightState = JSON.parse(persistedState ?? '{}');
      expect(inFlightState.processing).toBe(true);
      expect(inFlightState.processingTexts).toEqual([
        'batch-msg-1',
        'batch-msg-2',
      ]);
      expect(inFlightState.texts).toEqual([]);

      const retryResult = await store.scheduleRetryFlush(
        'discord-retry-1',
        5000,
        claimed!.leaseToken,
      );
      expect(retryResult).toBe(true);

      const retriedState = JSON.parse(persistedState ?? '{}');
      expect(retriedState.processing).toBe(false);
      expect(retriedState.processingTexts).toEqual([]);
      expect(retriedState.texts).toEqual(['batch-msg-1', 'batch-msg-2']);
      expect(retriedState.lastIdempotencyKey).toBe('mid-10');
      expect(retriedState.flushAfterAt).toBeGreaterThan(Date.now());
    });

    it('handles crash recovery after lease expiration without retry schedule', async () => {
      let persistedState: string | null = JSON.stringify({
        texts: ['crash-msg-1'],
        pendingTexts: [],
        processingTexts: [],
        processing: false,
        processingStartedAt: null,
        processingLeaseToken: null,
        flushAfterAt: Date.now() - 1000,
        lastIdempotencyKey: 'mid-crash',
      });
      const transaction = createTransaction();
      transaction.set.mockImplementation((_key: string, value: string) => {
        persistedState = value;
        return transaction;
      });
      const client = createClient(
        jest.fn().mockImplementation(() => Promise.resolve(persistedState)),
        transaction,
      );
      const store = createStore(client, 'zalo');

      const claimed = await store.claimReadyBuffer(
        'zalo-crash-1',
        2000,
        300_000,
      );
      expect(claimed?.texts).toEqual(['crash-msg-1']);

      const recovered = await store.claimReadyBuffer('zalo-crash-1', 2000, 0);
      expect(recovered?.texts).toEqual(['crash-msg-1']);
      expect(recovered?.lastIdempotencyKey).toBe('mid-crash');

      const recoveredState = JSON.parse(persistedState ?? '{}');
      expect(recoveredState.processing).toBe(true);
      expect(recoveredState.processingTexts).toEqual(['crash-msg-1']);
      expect(recoveredState.processingLeaseToken).toEqual(
        recovered?.leaseToken,
      );
    });

    it('fences completion from a worker whose claim was recovered', async () => {
      let persistedState: string | null = JSON.stringify({
        texts: ['fenced-msg'],
        pendingTexts: [],
        processingTexts: [],
        processing: false,
        processingStartedAt: null,
        processingLeaseToken: null,
        flushAfterAt: Date.now() - 1000,
      });
      const transaction = createTransaction();
      transaction.set.mockImplementation((_key: string, value: string) => {
        persistedState = value;
        return transaction;
      });
      const client = createClient(
        jest.fn().mockImplementation(() => Promise.resolve(persistedState)),
        transaction,
      );
      const firstWorker = createStore(client, 'discord');
      const firstClaim = await firstWorker.claimReadyBuffer(
        'discord-fenced-1',
        2000,
        300_000,
      );
      const secondWorker = createStore(client, 'discord');
      const secondClaim = await secondWorker.claimReadyBuffer(
        'discord-fenced-1',
        2000,
        0,
      );

      expect(firstClaim?.leaseToken).toBeDefined();
      expect(secondClaim?.leaseToken).toBeDefined();
      expect(secondClaim?.leaseToken).not.toBe(firstClaim?.leaseToken);

      await expect(
        firstWorker.completeChatBuffer({
          externalUserId: 'discord-fenced-1',
          debounceMs: 2000,
          leaseToken: firstClaim!.leaseToken,
        }),
      ).resolves.toBe(false);
      await expect(
        firstWorker.scheduleRetryFlush(
          'discord-fenced-1',
          5000,
          firstClaim!.leaseToken,
        ),
      ).resolves.toBe(false);

      const currentState = JSON.parse(persistedState ?? '{}');
      expect(currentState.processing).toBe(true);
      expect(currentState.processingLeaseToken).toBe(secondClaim?.leaseToken);
      expect(currentState.processingTexts).toEqual(['fenced-msg']);
    });

    it('retains a failed batch as abandoned after the retry budget is exhausted', async () => {
      let persistedState: string | null = JSON.stringify({
        texts: [],
        pendingTexts: [],
        processingTexts: ['abandoned-msg'],
        processing: true,
        processingStartedAt: Date.now(),
        processingLeaseToken: 'lease-abandoned',
        processingIdempotencyKey: 'mid-abandoned',
        lastIdempotencyKey: null,
        lastPendingIdempotencyKey: null,
        retryCount: 1,
        flushAfterAt: null,
      });
      const transaction = createTransaction();
      transaction.set.mockImplementation((_key: string, value: string) => {
        persistedState = value;
        return transaction;
      });
      const client = createClient(
        jest.fn().mockImplementation(() => Promise.resolve(persistedState)),
        transaction,
      );
      const outcomes: string[] = [];
      const store = new RedisChatQueueStore(
        {
          isEnabled: () => true,
          getNativeClient: () => client,
        } as unknown as RedisClientPort,
        {
          get: (key: string) =>
            key === 'CHAT_FLUSH_MAX_RETRIES' ? '1' : undefined,
        } as never,
        {
          platform: 'discord',
          onRecoveryOutcome: (outcome: string) => outcomes.push(outcome),
        } as never,
      );

      await expect(
        store.scheduleRetryFlush('discord-abandoned', 5000, 'lease-abandoned'),
      ).resolves.toBe(false);

      const abandonedState = JSON.parse(persistedState ?? '{}');
      expect(abandonedState.abandoned).toBe(true);
      expect(abandonedState.texts).toEqual(['abandoned-msg']);
      expect(abandonedState.lastIdempotencyKey).toBe('mid-abandoned');
      expect(outcomes).toContain('abandoned');
    });
  });

  it('treats a duplicate idempotency key as a successful no-op', async () => {
    let persistedState: string | null = null;
    const transaction = createTransaction();
    transaction.set.mockImplementation((_key: string, value: string) => {
      persistedState = value;
      return transaction;
    });
    const client = createClient(
      jest.fn().mockImplementation(() => Promise.resolve(persistedState)),
      transaction,
    );
    const store = createStore(client, 'discord');

    await store.appendChatBuffer({
      externalUserId: 'discord-1',
      userText: 'hello',
      idempotencyKey: 'message-1',
      debounceMs: 2000,
    });
    await expect(
      store.appendChatBuffer({
        externalUserId: 'discord-1',
        userText: 'hello',
        idempotencyKey: 'message-1',
        debounceMs: 2000,
      }),
    ).resolves.toBeUndefined();

    const stored = JSON.parse(persistedState ?? '{}') as { texts?: string[] };
    expect(stored.texts).toEqual(['hello']);
    expect(transaction.set).toHaveBeenCalledTimes(1);
  });
});
