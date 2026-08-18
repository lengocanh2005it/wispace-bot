import type { RedisClientPort } from '@wispace/bot-common';
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
