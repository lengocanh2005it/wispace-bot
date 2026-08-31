import { RedisWispaceCacheStore } from './redis-wispace-cache.store';
import type { WispaceCacheRedisCommands } from './redis-wispace-cache.store';

function redisMock(): WispaceCacheRedisCommands & {
  set: jest.Mock;
  eval: jest.Mock;
  scan: jest.Mock;
  del: jest.Mock;
  get: jest.Mock;
} {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    eval: jest.fn().mockResolvedValue(1),
    scan: jest.fn().mockResolvedValue(['0', []]),
    del: jest.fn().mockResolvedValue(1),
  };
}

describe('RedisWispaceCacheStore (#568)', () => {
  it('tryLock returns a token on NX claim and null when held', async () => {
    const client = redisMock();
    const store = new RedisWispaceCacheStore(client);

    const token = await store.tryLock('k', 5);
    expect(token).toEqual(expect.any(String));
    expect(client.set).toHaveBeenCalledWith('k', token, 'PX', 5000, 'NX');

    client.set.mockResolvedValue(null);
    expect(await store.tryLock('k', 5)).toBeNull();
  });

  it('unlock compares the token server-side (compare-and-del)', async () => {
    const client = redisMock();
    const store = new RedisWispaceCacheStore(client);

    await store.unlock('k', 'tok-1');

    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call'),
      1,
      'k',
      'tok-1',
    );
  });

  it('set writes with PX TTL in milliseconds', async () => {
    const client = redisMock();
    const store = new RedisWispaceCacheStore(client);

    await store.set('k', 'v', 15);

    expect(client.set).toHaveBeenCalledWith('k', 'v', 'PX', 15000);
  });

  it('deleteByPrefix scans with MATCH and deletes found keys', async () => {
    const client = redisMock();
    client.scan
      .mockResolvedValueOnce([
        '7',
        ['wispace-cache:u1:X', 'wispace-cache:u1:Y'],
      ])
      .mockResolvedValueOnce(['0', []]);
    const store = new RedisWispaceCacheStore(client);

    await store.deleteByPrefix('wispace-cache:u1:');

    expect(client.del).toHaveBeenCalledWith(
      'wispace-cache:u1:X',
      'wispace-cache:u1:Y',
    );
    expect(client.scan).toHaveBeenNthCalledWith(
      1,
      '0',
      'MATCH',
      'wispace-cache:u1:*',
      'COUNT',
      100,
    );
    expect(client.scan).toHaveBeenNthCalledWith(
      2,
      '7',
      'MATCH',
      expect.any(String),
      expect.anything(),
      expect.anything(),
    );
  });

  it('every operation fails soft and reports through onWarn', async () => {
    const warns: string[] = [];
    const client = redisMock();
    client.get.mockRejectedValue(new Error('redis down'));
    client.set.mockRejectedValue(new Error('redis down'));
    client.eval.mockRejectedValue(new Error('redis down'));
    client.scan.mockRejectedValue(new Error('redis down'));
    client.del.mockRejectedValue(new Error('redis down'));
    const store = new RedisWispaceCacheStore(client, {
      onWarn: (message) => warns.push(message),
    });

    await expect(store.get('k')).resolves.toBeNull();
    await expect(store.set('k', 'v', 1)).resolves.toBeUndefined();
    await expect(store.tryLock('k', 1)).resolves.toBeNull();
    await expect(store.unlock('k', 't')).resolves.toBeUndefined();
    await expect(store.deleteByPrefix('p')).resolves.toBeUndefined();

    expect(warns).toHaveLength(5);
  });
});
