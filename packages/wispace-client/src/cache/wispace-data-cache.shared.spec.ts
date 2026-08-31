import { WispaceDataCache } from './wispace-data-cache';
import { WISPACE_CACHE_POLICY } from './wispace-cache-policy';
import type { WispaceCacheSharedStore } from './wispace-cache-shared-store.port';

function memoryStore(): WispaceCacheSharedStore & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value, _ttlSeconds) {
      data.set(key, value);
    },
    async tryLock(key, _ttlSeconds) {
      if (data.has(`lock:${key}`)) {
        return null;
      }
      const token = `token-${data.size}`;
      data.set(`lock:${key}`, token);
      return token;
    },
    async unlock(key, token) {
      if (data.get(`lock:${key}`) === token) {
        data.delete(`lock:${key}`);
      }
    },
    async deleteByPrefix(prefix) {
      for (const key of [...data.keys()]) {
        if (key.startsWith(prefix)) {
          data.delete(key);
        }
      }
    },
  };
}

const POLL_MS = 15;

function cacheWithStore(store: WispaceCacheSharedStore) {
  return new WispaceDataCache({
    sharedStore: store,
    coordinationPollMs: POLL_MS,
    coordinationWaitBudgetMs: 400,
  });
}

describe('WispaceDataCache shared-store coordination (#568 stampede)', () => {
  it('two concurrent callers share one in-flight fetch (per-key dedup)', async () => {
    const cache = new WispaceDataCache();
    let resolveFetch!: (value: string) => void;
    const upstream = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const first = cache.getOrFetch('goals', 'u1', undefined, upstream);
    const second = cache.getOrFetch('goals', 'u1', undefined, upstream);
    resolveFetch('v1');
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe('v1');
    expect(b).toBe('v1');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('a failed in-flight fetch is not cached — the next caller retries', async () => {
    const cache = new WispaceDataCache();
    const upstream = jest
      .fn()
      .mockRejectedValueOnce(new Error('wispace down'))
      .mockResolvedValueOnce('v2');

    await expect(
      cache.getOrFetch('goals', 'u1', undefined, upstream),
    ).rejects.toThrow('wispace down');
    expect(await cache.getOrFetch('goals', 'u1', undefined, upstream)).toBe(
      'v2',
    );
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('a fetcher failure during lock-held coordination propagates once — no double upstream call, no extra wait', async () => {
    const store = memoryStore();
    const podA = cacheWithStore(store);
    const upstreamA = jest.fn().mockRejectedValue(new Error('wispace down'));

    await expect(
      podA.getOrFetch('goals', 'u1', undefined, upstreamA),
    ).rejects.toThrow('wispace down');
    expect(upstreamA).toHaveBeenCalledTimes(1);
    // The lock must be released after the failed fetch (no 5s stall).
    expect(
      [...store.data.keys()].filter((k) => k.startsWith('lock:')),
    ).toHaveLength(0);
  });

  it('write-through: a fresh fetch populates the shared store', async () => {
    const store = memoryStore();
    const cache = cacheWithStore(store);
    const upstream = jest.fn().mockResolvedValue({ examDate: '2026-01-01' });

    await cache.getOrFetch('goals', 'u1', undefined, upstream);

    expect(store.data.size).toBe(1);
    const raw = JSON.parse([...store.data.values()][0] as string) as {
      kind: string;
      userId: string;
      value: { examDate: string };
    };
    expect(raw.kind).toBe('goals');
    expect(raw.userId).toBe('u1');
    expect(raw.value).toEqual({ examDate: '2026-01-01' });
  });

  it('second pod observes the first pod value instead of fetching', async () => {
    const store = memoryStore();
    const firstPod = cacheWithStore(store);
    await firstPod.getOrFetch('goals', 'u1', undefined, () =>
      Promise.resolve('pod-1-value'),
    );

    const secondPod = cacheWithStore(store);
    const upstream = jest.fn().mockResolvedValue('pod-2-value');
    const value = await secondPod.getOrFetch(
      'goals',
      'u1',
      undefined,
      upstream,
    );

    expect(value).toBe('pod-1-value');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('concurrent cross-pod misses coordinate: one fetch, the waiter observes the written value', async () => {
    const store = memoryStore();
    const podA = cacheWithStore(store);
    const podB = cacheWithStore(store);
    let releaseA!: (value: string) => void;
    const upstreamA = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          releaseA = resolve;
        }),
    );
    const upstreamB = jest.fn().mockResolvedValue('pod-b-value');

    const callA = podA.getOrFetch('goals', 'u1', undefined, upstreamA);
    // Let pod A take the lock first.
    await new Promise((r) => setTimeout(r, POLL_MS * 4));
    const callB = podB.getOrFetch('goals', 'u1', undefined, upstreamB);

    releaseA('pod-a-value');
    const [a, b] = await Promise.all([callA, callB]);

    expect(a).toBe('pod-a-value');
    expect(b).toBe('pod-a-value');
    expect(upstreamA).toHaveBeenCalledTimes(1);
    expect(upstreamB).not.toHaveBeenCalled();
  });

  it('lock never acquired: bounded wait, then fail-open local fetch', async () => {
    const store: WispaceCacheSharedStore = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      tryLock: jest.fn().mockResolvedValue(null),
      unlock: jest.fn().mockResolvedValue(undefined),
      deleteByPrefix: jest.fn().mockResolvedValue(undefined),
    };
    const cache = new WispaceDataCache({
      sharedStore: store,
      coordinationPollMs: 10,
      coordinationWaitBudgetMs: 60,
    });
    const upstream = jest.fn().mockResolvedValue('fallback');

    const value = await cache.getOrFetch('goals', 'u1', undefined, upstream);

    expect(value).toBe('fallback');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('a corrupt shared value is treated as a miss and refetched', async () => {
    const store = memoryStore();
    const cache = cacheWithStore(store);
    // Write a garbage envelope under the key the cache will read.
    const probe = cacheWithStore(store);
    await probe.getOrFetch('goals', 'u1', undefined, () =>
      Promise.resolve('v'),
    );
    const keys = [...store.data.keys()].filter((k) => !k.startsWith('lock:'));
    store.data.set(keys[0] as string, 'not-json-at-all');
    const upstream = jest.fn().mockResolvedValue('fresh');

    const value = await cache.getOrFetch('goals', 'u1', undefined, upstream);

    expect(value).toBe('fresh');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('a shared entry past its policy TTL is a miss', async () => {
    const store = memoryStore();
    const podA = cacheWithStore(store);
    await podA.getOrFetch('goals', 'u1', undefined, () =>
      Promise.resolve('v1'),
    );

    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + WISPACE_CACHE_POLICY.goals + 1);
    try {
      const podB = cacheWithStore(store);
      const upstream = jest.fn().mockResolvedValue('v2');
      const value = await podB.getOrFetch('goals', 'u1', undefined, upstream);

      expect(value).toBe('v2');
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('shared store failures fail open to the local fetcher', async () => {
    const failingStore: WispaceCacheSharedStore = {
      get: jest.fn().mockRejectedValue(new Error('redis down')),
      set: jest.fn().mockRejectedValue(new Error('redis down')),
      tryLock: jest.fn().mockRejectedValue(new Error('redis down')),
      unlock: jest.fn().mockRejectedValue(new Error('redis down')),
      deleteByPrefix: jest.fn().mockRejectedValue(new Error('redis down')),
    };
    const cache = cacheWithStore(failingStore);
    const upstream = jest.fn().mockResolvedValue('local');

    const value = await cache.getOrFetch('goals', 'u1', undefined, upstream);

    expect(value).toBe('local');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('invalidateUser deletes the shared entries for the user', async () => {
    const store = memoryStore();
    const podA = cacheWithStore(store);
    await podA.getOrFetch('goals', 'u1', undefined, () =>
      Promise.resolve('v1'),
    );
    expect(store.data.size).toBeGreaterThan(0);

    podA.invalidateUser('u1');

    expect(
      [...store.data.keys()].filter((k) => !k.startsWith('lock:')),
    ).toHaveLength(0);
  });

  it('shared values round-trip Dates (calendar sessions)', async () => {
    const store = memoryStore();
    const at = new Date('2026-08-31T10:00:00.000Z');
    const podA = cacheWithStore(store);
    await podA.getOrFetch('calendar', 'u1', undefined, () =>
      Promise.resolve([{ scheduledAt: at, topic: 'Speaking' }]),
    );

    const podB = cacheWithStore(store);
    const value = await podB.getOrFetch('calendar', 'u1', undefined, () =>
      Promise.resolve([]),
    );

    expect(value).toEqual([{ scheduledAt: at, topic: 'Speaking' }]);
    expect(
      (value as Array<{ scheduledAt: Date }>)[0].scheduledAt,
    ).toBeInstanceOf(Date);
  });
});
