import type { RedisClientPort } from '@wispace/bot-common/redis';
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
  zadd: jest.Mock;
  zrem: jest.Mock;
  zrangebyscore: jest.Mock;
  zcard: jest.Mock;
  scard: jest.Mock;
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
    zadd: jest.fn().mockResolvedValue(1),
    zrem: jest.fn().mockResolvedValue(1),
    zrangebyscore: jest.fn().mockResolvedValue([]),
    zcard: jest.fn().mockResolvedValue(0),
    scard: jest.fn().mockResolvedValue(0),
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
      zadd: jest.fn(),
      zrem: jest.fn(),
      exec: jest.fn().mockResolvedValue(execResult),
    };
    transaction.set.mockReturnValue(transaction);
    transaction.sadd.mockReturnValue(transaction);
    transaction.del.mockReturnValue(transaction);
    transaction.srem.mockReturnValue(transaction);
    transaction.zadd.mockReturnValue(transaction);
    transaction.zrem.mockReturnValue(transaction);
    return transaction;
  };

  it('appends text to buffer under psid lock and tracks the flush deadline', async () => {
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
    expect(transaction.zadd).toHaveBeenCalledWith(
      'chat:queue:flush',
      expect.any(Number),
      'psid-1',
    );
    expect(transaction.zrem).toHaveBeenCalledWith('chat:queue:stuck', 'psid-1');
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

  it('#176: replays the claimed batch after a crash — claim [m] → expiry → recovery replays m', async () => {
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
    const store = createStore(client);

    // Seed a ready batch and claim it: 'm' moves into the persisted
    // in-flight copy (processingTexts).
    persistedState = JSON.stringify({
      texts: ['m'],
      pendingTexts: [],
      processingTexts: [],
      processing: false,
      processingStartedAt: null,
      flushAfterAt: Date.now() - 1,
      lastIdempotencyKey: 'mid-1',
      lastPendingIdempotencyKey: null,
    });
    const claimed = await store.claimReadyBuffer('psid-1', 2000, 300_000);
    expect(claimed?.texts).toEqual(['m']);
    const persistedAfterClaim = JSON.parse(persistedState) as {
      processingTexts: string[];
      texts: string[];
    };
    expect(persistedAfterClaim.processingTexts).toEqual(['m']);
    expect(persistedAfterClaim.texts).toEqual([]);

    // The worker crashes before completion; a fresh claim after lease
    // expiry replays the claimed batch (plus anything accumulated while
    // stuck) — 'm' is never lost.
    const recovered = await store.claimReadyBuffer('psid-1', 2000, 0);
    expect(recovered?.texts).toEqual(['m']);
  });

  it('drops a wedged buffer with no pending messages from every ZSET', async () => {
    const state = {
      texts: [],
      pendingTexts: [],
      processing: true,
      processingStartedAt: Date.now() - 301_000,
      flushAfterAt: null,
    };
    const transaction = createTransaction();
    const client = createClient({
      get: jest.fn().mockResolvedValue(JSON.stringify(state)),
      multi: jest.fn().mockReturnValue(transaction),
    });

    const store = createStore(client);
    const snapshot = await store.claimReadyBuffer('psid-1', 2000, 300_000);

    expect(snapshot).toBeNull();
    expect(transaction.del).toHaveBeenCalledWith('chat:queue:buffer:psid-1');
    expect(transaction.srem).toHaveBeenCalledWith(
      'chat:queue:active-psids',
      'psid-1',
    );
    expect(transaction.zrem).toHaveBeenCalledWith('chat:queue:flush', 'psid-1');
    expect(transaction.zrem).toHaveBeenCalledWith('chat:queue:stuck', 'psid-1');
  });

  it('claim moves the member from the flush set to the stuck set', async () => {
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
    persistedState = JSON.stringify({
      texts: ['hello'],
      pendingTexts: [],
      processing: false,
      flushAfterAt: Date.now() - 1000,
      lastIdempotencyKey: 'mid-1',
    });

    const snapshot = await store.claimReadyBuffer('psid-1', 2000, 300_000);

    expect(snapshot?.texts).toEqual(['hello']);
    expect(transaction.zrem).toHaveBeenCalledWith('chat:queue:flush', 'psid-1');
    expect(transaction.zadd).toHaveBeenCalledWith(
      'chat:queue:stuck',
      expect.any(Number),
      'psid-1',
    );
  });

  it('complete with pending messages returns the member to the flush set', async () => {
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
    persistedState = JSON.stringify({
      texts: [],
      pendingTexts: ['pending-1'],
      processing: true,
      processingStartedAt: Date.now() - 1000,
      processingLeaseToken: 'lease-pending',
      flushAfterAt: null,
      lastPendingIdempotencyKey: 'mid-2',
    });

    const result = await store.completeChatBuffer({
      psid: 'psid-1',
      debounceMs: 2000,
      leaseToken: 'lease-pending',
    });

    expect(result).toBe(true);
    expect(transaction.zrem).toHaveBeenCalledWith('chat:queue:stuck', 'psid-1');
    expect(transaction.zadd).toHaveBeenCalledWith(
      'chat:queue:flush',
      expect.any(Number),
      'psid-1',
    );
  });

  it('complete without pending messages drops every membership', async () => {
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
    persistedState = JSON.stringify({
      texts: [],
      pendingTexts: [],
      processing: true,
      processingStartedAt: Date.now() - 1000,
      processingLeaseToken: 'lease-empty',
      flushAfterAt: null,
    });

    const result = await store.completeChatBuffer({
      psid: 'psid-1',
      debounceMs: 2000,
      leaseToken: 'lease-empty',
    });

    expect(result).toBe(false);
    expect(transaction.del).toHaveBeenCalledWith('chat:queue:buffer:psid-1');
    expect(transaction.srem).toHaveBeenCalledWith(
      'chat:queue:active-psids',
      'psid-1',
    );
    expect(transaction.zrem).toHaveBeenCalledWith('chat:queue:flush', 'psid-1');
    expect(transaction.zrem).toHaveBeenCalledWith('chat:queue:stuck', 'psid-1');
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

    await store.completeChatBuffer({
      psid: 'psid-1',
      debounceMs: 2000,
      leaseToken: snapshot!.leaseToken,
    });
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

  it('lists a stuck psid from the stuck ZSET without scanning the active set', async () => {
    const client = createClient({
      zrangebyscore: jest
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(
            key === 'chat:queue:stuck'
              ? ['psid-1', String(Date.now() - 1000)]
              : [],
          ),
        ),
      exists: jest.fn().mockResolvedValue(1),
    });

    const store = createStore(client);
    const ready = await store.listPsidsReadyForFlush(25);

    expect(ready).toEqual(['psid-1']);
    expect(client.smembers).not.toHaveBeenCalled();
    expect(client.zrangebyscore).toHaveBeenCalledTimes(2);
  });

  it('polls with bounded commands regardless of active-user count', async () => {
    const client = createClient({
      zcard: jest.fn().mockResolvedValue(10_000),
      zrangebyscore: jest.fn().mockResolvedValue([]),
    });

    const store = createStore(client);
    await store.listPsidsReadyForFlush(25);

    expect(client.smembers).not.toHaveBeenCalled();
    expect(client.zrangebyscore).toHaveBeenCalledWith(
      'chat:queue:flush',
      0,
      expect.any(Number),
      'WITHSCORES',
      'LIMIT',
      0,
      25,
    );
    expect(client.zrangebyscore).toHaveBeenCalledWith(
      'chat:queue:stuck',
      0,
      expect.any(Number),
      'WITHSCORES',
      'LIMIT',
      0,
      25,
    );
    // Candidates are capped by the limit, not by the number of active users.
    expect(client.exists).not.toHaveBeenCalled();
  });

  it('rehydrates legacy active-set members once when both ZSETs are empty', async () => {
    const client = createClient({
      zcard: jest.fn().mockResolvedValue(0),
      scard: jest.fn().mockResolvedValue(1),
      smembers: jest.fn().mockResolvedValue(['psid-1']),
      get: jest.fn().mockResolvedValue(
        JSON.stringify({
          texts: ['hello'],
          pendingTexts: [],
          processing: false,
          flushAfterAt: Date.now() - 1000,
        }),
      ),
    });

    const store = createStore(client);
    await store.listPsidsReadyForFlush(25);

    expect(client.set).toHaveBeenCalledWith(
      'chat:queue:rehydrate-lock',
      expect.any(String),
      'PX',
      60_000,
      'NX',
    );
    expect(client.zadd).toHaveBeenCalledWith(
      'chat:queue:flush',
      expect.any(Number),
      'psid-1',
    );
    expect(client.del).toHaveBeenCalledWith('chat:queue:rehydrate-lock');
  });

  it('skips rehydration when another pod holds the rehydrate lock', async () => {
    const client = createClient({
      zcard: jest.fn().mockResolvedValue(0),
      scard: jest.fn().mockResolvedValue(5),
      set: jest.fn().mockResolvedValue(null),
    });

    const store = createStore(client);
    await store.listPsidsReadyForFlush(25);

    expect(client.smembers).not.toHaveBeenCalled();
    expect(client.zadd).not.toHaveBeenCalled();
  });

  it('drops stale members whose buffer key expired', async () => {
    const client = createClient({
      zrangebyscore: jest
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(
            key === 'chat:queue:stuck'
              ? ['psid-1', String(Date.now() - 1000)]
              : [],
          ),
        ),
      exists: jest.fn().mockResolvedValue(0),
      get: jest.fn().mockResolvedValue(null),
    });

    const store = createStore(client);
    const ready = await store.listPsidsReadyForFlush(25);

    expect(ready).toEqual([]);
    expect(client.srem).not.toHaveBeenCalled();
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("exists", KEYS[1])'),
      4,
      'chat:queue:buffer:psid-1',
      'chat:queue:active-psids',
      'chat:queue:flush',
      'chat:queue:stuck',
      'psid-1',
    );
  });

  it('does not remove an active member restored after the stale read', async () => {
    let bufferRestored = false;
    const activePsids = new Set(['psid-1']);
    const client = createClient({
      zrangebyscore: jest
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(
            key === 'chat:queue:stuck'
              ? ['psid-1', String(Date.now() - 1000)]
              : [],
          ),
        ),
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
    await store.listPsidsReadyForFlush(25);

    expect(activePsids.has('psid-1')).toBe(true);
    expect(client.srem).not.toHaveBeenCalled();
  });
});
