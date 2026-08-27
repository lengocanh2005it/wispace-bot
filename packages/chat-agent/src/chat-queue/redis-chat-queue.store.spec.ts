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

      await store.scheduleRetryFlush('discord-1', 5000);

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

      await store.scheduleRetryFlush('discord-1', 5000);

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

      await store.scheduleRetryFlush('zalo-1', 5000);

      const written = JSON.parse(persistedState ?? '{}') as {
        texts: string[];
        pendingTexts: string[];
        processingTexts: string[];
      };
      expect(written.texts).toEqual(['claimed-msg', 'pending-msg']);
      expect(written.pendingTexts).toEqual([]);
      expect(written.processingTexts).toEqual([]);
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
