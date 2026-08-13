import type { RedisClientPort } from '@wispace/bot-common';
import { RedisChatQueueStore } from './redis-chat-queue.store';

interface MockClient {
  set: jest.Mock;
  get: jest.Mock;
  del: jest.Mock;
  sadd: jest.Mock;
  srem: jest.Mock;
  smembers: jest.Mock;
  eval: jest.Mock;
  exists: jest.Mock;
  multi: jest.Mock;
}

describe('RedisChatQueueStore', () => {
  const createStore = (client: MockClient | null) => {
    const redisClient = {
      isEnabled: () => client !== null,
      getNativeClient: () => client,
      ping: jest.fn(),
    } as unknown as RedisClientPort;

    return new RedisChatQueueStore(redisClient, {
      get: () => undefined,
    } as never);
  };

  const createClient = (overrides: Partial<MockClient> = {}): MockClient => ({
    set: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    del: jest.fn(),
    sadd: jest.fn().mockResolvedValue(1),
    srem: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
    eval: jest.fn().mockResolvedValue(1),
    exists: jest.fn().mockResolvedValue(1),
    multi: jest.fn(() => createTransaction()),
    ...overrides,
  });

  const createTransaction = (
    execResult: Array<[Error | null, unknown]> | null = [
      [null, 'OK'],
      [null, 1],
    ],
  ) => {
    const transaction = {
      set: jest.fn(),
      sadd: jest.fn(),
      del: jest.fn(),
      srem: jest.fn(),
      exec: jest.fn().mockResolvedValue(execResult),
    };
    transaction.set.mockReturnValue(transaction);
    transaction.sadd.mockReturnValue(transaction);
    transaction.del.mockReturnValue(transaction);
    transaction.srem.mockReturnValue(transaction);
    return transaction;
  };

  it('appends text to buffer under psid lock', async () => {
    const client = createClient();
    const transaction = createTransaction();
    client.multi.mockReturnValue(transaction);

    const store = createStore(client);
    await store.appendChatBuffer({
      psid: 'psid-1',
      userText: 'hello',
      debounceMs: 2000,
      idempotencyKey: 'mid-1',
    });

    expect(client.set).toHaveBeenCalledWith(
      expect.stringContaining('chat:queue:lock:psid-1'),
      expect.any(String),
      'PX',
      30_000,
      'NX',
    );
    expect(transaction.set).toHaveBeenCalledWith(
      'chat:queue:buffer:psid-1',
      expect.stringContaining('"hello"'),
      'EX',
      86_400,
    );
    expect(transaction.sadd).toHaveBeenCalledWith(
      'chat:queue:active-psids',
      'psid-1',
    );
  });

  it('writes the buffer and active-set membership atomically', async () => {
    const transaction = createTransaction();
    const client = createClient({
      multi: jest.fn().mockReturnValue(transaction),
    });

    const store = createStore(client);
    await store.appendChatBuffer({
      psid: 'psid-1',
      userText: 'hello',
      debounceMs: 2000,
    });

    expect(client.multi).toHaveBeenCalledTimes(1);
    expect(transaction.exec).toHaveBeenCalledTimes(1);
    expect(transaction.set.mock.invocationCallOrder[0]).toBeLessThan(
      transaction.sadd.mock.invocationCallOrder[0],
    );
  });

  it('rejects append when the psid lock is busy', async () => {
    const client = createClient({
      set: jest.fn().mockResolvedValue(null),
    });

    const store = createStore(client);

    await expect(
      store.appendChatBuffer({
        psid: 'psid-1',
        userText: 'hello',
        debounceMs: 2000,
      }),
    ).rejects.toThrow('Redis chat queue lock busy');
  });

  it('rejects append when Redis write fails', async () => {
    const client = createClient({
      multi: jest.fn().mockReturnValue(
        createTransaction([
          [new Error('Redis write failed'), null],
          [null, 1],
        ]),
      ),
    });

    const store = createStore(client);

    await expect(
      store.appendChatBuffer({
        psid: 'psid-1',
        userText: 'hello',
        debounceMs: 2000,
      }),
    ).rejects.toThrow('Redis write failed');
  });

  it('does not duplicate an append when a persisted write reports failure', async () => {
    let persistedState: string | null = null;
    const transaction = createTransaction();
    const client = createClient({
      get: jest.fn().mockImplementation(() => Promise.resolve(persistedState)),
      set: jest.fn().mockImplementation((key: string, value?: string) => {
        if (key.startsWith('chat:queue:lock:')) {
          return Promise.resolve('OK');
        }
        return Promise.resolve(value);
      }),
      multi: jest.fn().mockReturnValue(transaction),
    });
    transaction.set.mockImplementation((_key: string, value: string) => {
      persistedState = value;
      return transaction;
    });
    transaction.exec
      .mockResolvedValueOnce([
        [new Error('Redis write failed after persist'), null],
        [null, 1],
      ])
      .mockResolvedValueOnce([
        [null, 'OK'],
        [null, 1],
      ]);

    const store = createStore(client);

    await expect(
      store.appendChatBuffer({
        psid: 'psid-1',
        userText: 'hello',
        debounceMs: 2000,
        idempotencyKey: 'mid-1',
      }),
    ).rejects.toThrow('Redis write failed after persist');

    await store.appendChatBuffer({
      psid: 'psid-1',
      userText: 'hello',
      debounceMs: 2000,
      idempotencyKey: 'mid-1',
    });

    const parsedState = JSON.parse(persistedState ?? '{}') as {
      texts?: string[];
    };
    expect(parsedState.texts).toEqual(['hello']);
    expect(
      transaction.set.mock.calls.filter(([key]) =>
        String(key).startsWith('chat:queue:buffer:'),
      ),
    ).toHaveLength(1);
  });

  it('deduplicates against the legacy last idempotency key', async () => {
    const client = createClient({
      get: jest.fn().mockResolvedValue(
        JSON.stringify({
          texts: ['hello'],
          pendingTexts: [],
          processing: false,
          lastIdempotencyKey: 'mid-1',
        }),
      ),
    });

    const store = createStore(client);
    await store.appendChatBuffer({
      psid: 'psid-1',
      userText: 'hello',
      debounceMs: 2000,
      idempotencyKey: 'mid-1',
    });

    expect(
      client.set.mock.calls.filter(([key]) =>
        String(key).startsWith('chat:queue:buffer:'),
      ),
    ).toHaveLength(0);
    expect(client.sadd).toHaveBeenCalledWith(
      'chat:queue:active-psids',
      'psid-1',
    );
  });

  it('rejects append when lock release fails', async () => {
    const client = createClient({
      eval: jest.fn().mockRejectedValue(new Error('Redis release failed')),
    });

    const store = createStore(client);

    await expect(
      store.appendChatBuffer({
        psid: 'psid-1',
        userText: 'hello',
        debounceMs: 2000,
      }),
    ).rejects.toThrow('Redis release failed');
  });

  it('rejects append when Redis is unavailable', async () => {
    const store = createStore(null);

    await expect(
      store.appendChatBuffer({
        psid: 'psid-1',
        userText: 'hello',
        debounceMs: 2000,
      }),
    ).rejects.toThrow('Redis chat queue unavailable');
  });

  it('returns null from claim when buffer is empty', async () => {
    const client = createClient();

    const store = createStore(client);
    const snapshot = await store.claimReadyBuffer('psid-1', 2000, 300_000);

    expect(snapshot).toBeNull();
  });

  it('claims a wedged buffer: processing stuck promotes pendingTexts', async () => {
    const state = {
      texts: [],
      pendingTexts: ['msg-while-stuck'],
      processing: true,
      processingStartedAt: Date.now() - 301_000,
      flushAfterAt: null,
      lastIdempotencyKey: null,
      lastPendingIdempotencyKey: 'mid-2',
    };
    const client = createClient({
      get: jest.fn().mockResolvedValue(JSON.stringify(state)),
    });

    const store = createStore(client);
    const snapshot = await store.claimReadyBuffer('psid-1', 2000, 300_000);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.texts).toEqual(['msg-while-stuck']);
    expect(snapshot?.lastIdempotencyKey).toBe('mid-2');
  });

  it('flags droppedNoticePending when the buffer cap is exceeded and clears it on completion', async () => {
    jest.useFakeTimers();

    let persistedState: string | null = null;
    const transaction = createTransaction();
    const client = createClient({
      get: jest.fn().mockImplementation(() => Promise.resolve(persistedState)),
      set: jest.fn().mockImplementation((key: string, value?: string) => {
        if (key.startsWith('chat:queue:lock:')) {
          return Promise.resolve('OK');
        }
        return Promise.resolve(value);
      }),
      multi: jest.fn().mockReturnValue(transaction),
    });
    transaction.set.mockImplementation((_key: string, value: string) => {
      persistedState = value;
      return transaction;
    });
    transaction.exec.mockResolvedValue([
      [null, 'OK'],
      [null, 1],
    ]);

    const store = createStore(client);
    const fullTexts = Array.from({ length: 20 }, (_, i) => `msg-${i}`);

    persistedState = JSON.stringify({
      texts: fullTexts,
      pendingTexts: ['pending-1'],
      processing: false,
      flushAfterAt: Date.now() - 1000,
    });

    await store.appendChatBuffer({
      psid: 'psid-1',
      userText: 'msg-overflow',
      debounceMs: 2000,
    });

    const afterAppend = JSON.parse(persistedState ?? '{}') as {
      texts: string[];
      droppedNoticePending?: boolean | null;
    };
    expect(afterAppend.texts).toHaveLength(20);
    expect(afterAppend.texts[0]).toBe('msg-1');
    expect(afterAppend.droppedNoticePending).toBe(true);

    await jest.advanceTimersByTimeAsync(2500);

    const snapshot = await store.claimReadyBuffer('psid-1', 2000, 300_000);
    expect(snapshot?.droppedNoticePending).toBe(true);

    await store.completeChatBuffer({ psid: 'psid-1', debounceMs: 2000 });
    const afterComplete = JSON.parse(persistedState ?? '{}') as {
      droppedNoticePending?: boolean | null;
    };
    expect(afterComplete.droppedNoticePending).toBe(null);

    jest.useRealTimers();
  });

  it('does not claim a processing buffer that is not stuck yet', async () => {
    const state = {
      texts: [],
      pendingTexts: ['msg'],
      processing: true,
      processingStartedAt: Date.now() - 10_000,
      flushAfterAt: null,
    };
    const client = createClient({
      get: jest.fn().mockResolvedValue(JSON.stringify(state)),
    });

    const store = createStore(client);
    const snapshot = await store.claimReadyBuffer('psid-1', 2000, 300_000);

    expect(snapshot).toBeNull();
  });

  it('lists a wedged psid as ready even when texts are empty', async () => {
    const wedgedState = {
      texts: [],
      pendingTexts: ['msg'],
      processing: true,
      processingStartedAt: Date.now() - 301_000,
      flushAfterAt: null,
    };
    const client = createClient({
      smembers: jest.fn().mockResolvedValue(['psid-1']),
      get: jest.fn().mockResolvedValue(JSON.stringify(wedgedState)),
    });

    const store = createStore(client);
    const ready = await store.listPsidsReadyForFlush(25, 300_000);

    expect(ready).toEqual(['psid-1']);
  });

  it('drops stale active-set members whose buffer key expired', async () => {
    const client = createClient({
      smembers: jest.fn().mockResolvedValue(['psid-1']),
      exists: jest.fn().mockResolvedValue(0),
      get: jest.fn().mockResolvedValue(null),
    });

    const store = createStore(client);
    const ready = await store.listPsidsReadyForFlush(25, 300_000);

    expect(ready).toEqual([]);
    expect(client.srem).not.toHaveBeenCalled();
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("exists", KEYS[1])'),
      2,
      'chat:queue:buffer:psid-1',
      'chat:queue:active-psids',
      'psid-1',
    );
  });

  it('does not remove an active member restored after the stale read', async () => {
    let bufferRestored = false;
    const activePsids = new Set(['psid-1']);
    const client = createClient({
      smembers: jest.fn().mockResolvedValue(['psid-1']),
      exists: jest.fn().mockImplementation(() => {
        bufferRestored = true;
        return 0;
      }),
      eval: jest.fn().mockImplementation(() => {
        if (!bufferRestored) {
          activePsids.delete('psid-1');
        }
      }),
    });

    const store = createStore(client);
    await store.listPsidsReadyForFlush(25, 300_000);

    expect(activePsids.has('psid-1')).toBe(true);
    expect(client.srem).not.toHaveBeenCalled();
  });
});
