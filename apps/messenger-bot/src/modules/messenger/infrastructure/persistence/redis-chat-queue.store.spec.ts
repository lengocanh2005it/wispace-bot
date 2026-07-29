import type { RedisClientPort } from '@messenger/infrastructure/redis/redis.client.port';
import { RedisChatQueueStore } from './redis-chat-queue.store';

describe('RedisChatQueueStore', () => {
  const createStore = (
    client: {
      set: jest.Mock;
      get: jest.Mock;
      del: jest.Mock;
      sadd: jest.Mock;
      srem: jest.Mock;
      smembers: jest.Mock;
      eval: jest.Mock;
    } | null,
  ) => {
    const redisClient = {
      isEnabled: () => client !== null,
      getNativeClient: () => client,
      ping: jest.fn(),
    } as unknown as RedisClientPort;

    return new RedisChatQueueStore(redisClient);
  };

  it('appends text to buffer under psid lock', async () => {
    const client = {
      set: jest.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn(),
      sadd: jest.fn().mockResolvedValue(1),
      srem: jest.fn(),
      smembers: jest.fn(),
      eval: jest.fn().mockResolvedValue(1),
    };

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
      5000,
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

  it('returns null from claim when buffer is empty', async () => {
    const client = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn(),
      sadd: jest.fn(),
      srem: jest.fn(),
      smembers: jest.fn(),
      eval: jest.fn().mockResolvedValue(1),
    };

    const store = createStore(client);
    const snapshot = await store.claimReadyBuffer('psid-1', 2000, 300_000);

    expect(snapshot).toBeNull();
  });
});
