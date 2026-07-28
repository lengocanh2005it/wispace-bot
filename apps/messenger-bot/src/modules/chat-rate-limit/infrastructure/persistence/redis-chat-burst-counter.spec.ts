import type { RedisClientPort } from '../../../../infrastructure/redis/redis.client.port';
import { RedisChatBurstCounter } from './redis-chat-burst-counter';

describe('RedisChatBurstCounter', () => {
  const createCounter = (
    client: {
      get: jest.Mock;
      incr: jest.Mock;
      expire: jest.Mock;
      decr: jest.Mock;
      del: jest.Mock;
      eval?: jest.Mock;
    } | null,
  ) => {
    const redisClient = {
      isEnabled: () => client !== null,
      getNativeClient: () => client,
      ping: jest.fn(),
    } as unknown as RedisClientPort;

    return new RedisChatBurstCounter(redisClient);
  };

  it('releases burst slot by decrementing key', async () => {
    const client = {
      get: jest.fn().mockResolvedValue('2'),
      incr: jest.fn(),
      expire: jest.fn(),
      decr: jest.fn().mockResolvedValue(1),
      del: jest.fn(),
    };

    const counter = createCounter(client);
    await counter.releaseReservation('psid-1');

    expect(client.decr).toHaveBeenCalled();
  });

  describe('tryReserveBurst', () => {
    it('allows and increments when under limit', async () => {
      const client = {
        get: jest.fn(),
        incr: jest.fn(),
        expire: jest.fn(),
        decr: jest.fn(),
        del: jest.fn(),
        eval: jest.fn().mockResolvedValue([1, 2]),
      };
      const counter = createCounter(client);
      const result = await counter.tryReserveBurst('psid-1', 3);
      expect(result).toEqual({ allowed: true, count: 2 });
      expect(client.eval).toHaveBeenCalled();
    });

    it('denies when at limit (Lua returns 0)', async () => {
      const client = {
        get: jest.fn(),
        incr: jest.fn(),
        expire: jest.fn(),
        decr: jest.fn(),
        del: jest.fn(),
        eval: jest.fn().mockResolvedValue([0, 3]),
      };
      const counter = createCounter(client);
      const result = await counter.tryReserveBurst('psid-1', 3);
      expect(result).toEqual({ allowed: false, count: 3 });
    });

    it('fails open when Redis unavailable', async () => {
      const counter = createCounter(null);
      const result = await counter.tryReserveBurst('psid-1', 3);
      expect(result).toEqual({ allowed: true, count: 0 });
    });

    it('fails open on Redis error', async () => {
      const client = {
        get: jest.fn(),
        incr: jest.fn(),
        expire: jest.fn(),
        decr: jest.fn(),
        del: jest.fn(),
        eval: jest.fn().mockRejectedValue(new Error('EVALSHA failed')),
      };
      const counter = createCounter(client);
      const result = await counter.tryReserveBurst('psid-1', 3);
      expect(result).toEqual({ allowed: true, count: 0 });
    });
  });
});
