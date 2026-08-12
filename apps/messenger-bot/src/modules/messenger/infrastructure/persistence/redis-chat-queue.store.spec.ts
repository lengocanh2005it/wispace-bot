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
    ...overrides,
  });

  it('appends text to buffer under psid lock', async () => {
    const client = createClient();

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
    expect(client.set).toHaveBeenCalledWith(
      'chat:queue:buffer:psid-1',
      expect.stringContaining('"hello"'),
      'EX',
      86_400,
    );
    expect(client.sadd).toHaveBeenCalledWith(
      'chat:queue:active-psids',
      'psid-1',
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
      set: jest
        .fn()
        .mockResolvedValueOnce('OK')
        .mockRejectedValueOnce(new Error('Redis write failed')),
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
    const client = createClient({
      get: jest.fn().mockImplementation(() => Promise.resolve(persistedState)),
      set: jest.fn().mockImplementation((key: string, value?: string) => {
        if (key.startsWith('chat:queue:lock:')) {
          return Promise.resolve('OK');
        }

        persistedState = value ?? null;
        return Promise.reject(new Error('Redis write failed after persist'));
      }),
    });

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
      client.set.mock.calls.filter(([key]) =>
        String(key).startsWith('chat:queue:buffer:'),
      ),
    ).toHaveLength(1);
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
    expect(client.srem).toHaveBeenCalledWith(
      'chat:queue:active-psids',
      'psid-1',
    );
  });
});
