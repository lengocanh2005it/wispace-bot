import {
  MemoryCompactionCache,
  RedisCompactionCache,
  computeCompactionCoverage,
  type CompactionCachePort,
} from './compaction-cache';

function makeEntry(content: string, role: 'user' | 'assistant' = 'user') {
  return { role, content };
}

function buildRedisClient() {
  const state = new Map<string, { value: string; expiresAt: number }>();
  const client = {
    get: jest.fn(async (key: string) => {
      const row = state.get(key);
      if (!row || Date.now() > row.expiresAt) return null;
      return row.value;
    }),
    set: jest.fn(
      async (
        key: string,
        value: string,
        _mode?: string,
        ttlSec?: number,
      ): Promise<'OK'> => {
        state.set(key, {
          value,
          expiresAt: Date.now() + (ttlSec ?? 3600) * 1000,
        });
        return 'OK';
      },
    ),
    del: jest.fn(async (key: string) => (state.delete(key) ? 1 : 0)),
    eval: jest.fn(),
  };
  return { client, state };
}

describe('computeCompactionCoverage (#704)', () => {
  it('returns null for an empty prefix', () => {
    expect(computeCompactionCoverage([])).toBeNull();
  });

  it('is deterministic for the same prefix', () => {
    const entries = [
      makeEntry('first'),
      makeEntry('middle'),
      makeEntry('last'),
    ];
    expect(computeCompactionCoverage(entries)).toEqual(
      computeCompactionCoverage(entries),
    );
  });

  it('changes when the covered prefix changes', () => {
    const before = computeCompactionCoverage([
      makeEntry('first'),
      makeEntry('last-a'),
    ]);
    const after = computeCompactionCoverage([
      makeEntry('first'),
      makeEntry('extra'),
      makeEntry('last-a'),
    ]);
    expect(after).not.toEqual(before);
  });

  it('changes when the first or last entry content changes', () => {
    const before = computeCompactionCoverage([
      makeEntry('first'),
      makeEntry('last'),
    ]);
    const changed = computeCompactionCoverage([
      makeEntry('FIRST'),
      makeEntry('last'),
    ]);
    expect(changed).not.toEqual(before);
  });

  it('changes when only the middle of the prefix changes', () => {
    const before = computeCompactionCoverage([
      makeEntry('first'),
      makeEntry('middle-a'),
      makeEntry('last'),
    ]);
    const changed = computeCompactionCoverage([
      makeEntry('first'),
      makeEntry('middle-b'),
      makeEntry('last'),
    ]);
    expect(changed).not.toEqual(before);
  });
});

describe.each([
  ['memory', () => new MemoryCompactionCache({ ttlMs: 60_000 })],
  [
    'redis',
    () => {
      const { client } = buildRedisClient();
      return new RedisCompactionCache(client, {
        ttlSec: 3600,
        keyPrefix: 'chat-history:test:',
      });
    },
  ],
])('%s compaction cache (#704)', (_name, build) => {
  let cache: CompactionCachePort;
  beforeEach(() => {
    cache = build();
  });
  afterEach(async () => {
    const maybeDisposable = cache as unknown as { dispose?: () => void };
    maybeDisposable.dispose?.();
  });

  it('misses before anything is stored', async () => {
    await expect(cache.get('u1')).resolves.toBeNull();
  });

  it('hits after set with identical coverage', async () => {
    const coverage = computeCompactionCoverage([
      makeEntry('first'),
      makeEntry('last'),
    ])!;
    await cache.set('u1', { text: 'summary', coverage });

    await expect(cache.get('u1')).resolves.toEqual({
      text: 'summary',
      coverage,
    });
  });

  it('misses when the covered prefix changed', async () => {
    const before = computeCompactionCoverage([
      makeEntry('first'),
      makeEntry('last-a'),
    ])!;
    await cache.set('u1', { text: 'stale', coverage: before });

    const after = computeCompactionCoverage([
      makeEntry('first'),
      makeEntry('extra'),
      makeEntry('last-a'),
    ])!;
    expect(after).not.toEqual(before);
    // A caller comparing coverage treats this stored entry as stale.
    const stored = await cache.get('u1');
    expect(stored?.coverage).not.toEqual(after);
  });

  it('last write wins on overwrite', async () => {
    const first = computeCompactionCoverage([makeEntry('a')])!;
    const second = computeCompactionCoverage([makeEntry('a'), makeEntry('b')])!;
    await cache.set('u1', { text: 'one', coverage: first });
    await cache.set('u1', { text: 'two', coverage: second });

    await expect(cache.get('u1')).resolves.toEqual({
      text: 'two',
      coverage: second,
    });
  });

  it('clear removes the summary (erasure path)', async () => {
    const coverage = computeCompactionCoverage([makeEntry('a')])!;
    await cache.set('u1', { text: 'summary', coverage });

    await cache.clear('u1');

    await expect(cache.get('u1')).resolves.toBeNull();
  });

  it('clear on a missing key is a safe no-op', async () => {
    await expect(cache.clear('nobody')).resolves.toBeUndefined();
  });

  it('treats malformed stored data as a miss', async () => {
    await cache.set('u1', {
      text: 'x',
      coverage: computeCompactionCoverage([makeEntry('a')])!,
    });
    // Corrupt behind the port's back where the test can reach storage.
    const redis = cache as unknown as {
      client?: { get: jest.Mock };
    };
    if (redis.client) {
      redis.client.get.mockResolvedValueOnce('not-json{{{');
    } else {
      const memory = cache as unknown as { store: Map<string, unknown> };
      memory.store.set('u1', { summary: 'garbage', updatedAt: Date.now() });
    }

    await expect(cache.get('u1')).resolves.toBeNull();
  });
});

describe('RedisCompactionCache key shape (#704)', () => {
  it('scopes keys by the history key prefix', async () => {
    const { client, state } = buildRedisClient();
    const cache = new RedisCompactionCache(client, {
      ttlSec: 3600,
      keyPrefix: 'chat-history:discord:',
    });
    const coverage = computeCompactionCoverage([makeEntry('a')])!;
    await cache.set('u1', { text: 's', coverage });

    expect([...state.keys()]).toEqual(['chat-history:discord:compaction:u1']);
  });

  it('refreshes the TTL on a hit (sliding expiry)', async () => {
    const { client } = buildRedisClient();
    const cache = new RedisCompactionCache(client, {
      ttlSec: 3600,
      keyPrefix: 'chat-history:discord:',
    });
    const coverage = computeCompactionCoverage([makeEntry('a')])!;
    await cache.set('u1', { text: 's', coverage });
    const setsAfterWrite = client.set.mock.calls.length;

    await cache.get('u1');

    expect(client.set.mock.calls.length).toBeGreaterThan(setsAfterWrite);
  });
});

describe('MemoryCompactionCache expiry (#704)', () => {
  it('expires entries past the TTL', async () => {
    const cache = new MemoryCompactionCache({ ttlMs: 20, sweepMs: 10 });
    const coverage = computeCompactionCoverage([makeEntry('a')])!;
    await cache.set('u1', { text: 's', coverage });

    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(cache.get('u1')).resolves.toBeNull();
    cache.dispose();
  });
});
