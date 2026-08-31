import { WispaceDataCache } from './wispace-data-cache';
import { WISPACE_CACHE_POLICY } from './wispace-cache-policy';

describe('WispaceDataCache (#636 coherence contract)', () => {
  let now: number;
  let nowSpy: jest.SpyInstance<number, []>;

  beforeEach(() => {
    now = 1_700_000_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  const fetcher = (value: unknown, spy?: jest.Mock) => () => {
    spy?.();
    return Promise.resolve(value);
  };

  it('delegates on miss and caches within the kind TTL', async () => {
    const cache = new WispaceDataCache();
    const calls = jest.fn();

    const first = await cache.getOrFetch(
      'goals',
      'user-1',
      undefined,
      fetcher({ examDate: '2026-01-01' }, calls),
    );
    const second = await cache.getOrFetch(
      'goals',
      'user-1',
      undefined,
      fetcher({ examDate: 'other' }, calls),
    );

    expect(first).toEqual({ examDate: '2026-01-01' });
    expect(second).toEqual({ examDate: '2026-01-01' });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('refetches after the kind TTL elapses', async () => {
    const cache = new WispaceDataCache();
    const calls = jest.fn();

    await cache.getOrFetch('goals', 'user-1', undefined, fetcher('v1', calls));
    now += WISPACE_CACHE_POLICY.goals - 1;
    await cache.getOrFetch('goals', 'user-1', undefined, fetcher('v1', calls));
    now += 2;
    await cache.getOrFetch('goals', 'user-1', undefined, fetcher('v2', calls));

    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('applies the per-kind TTL policy (calendar shorter than scores)', async () => {
    const cache = new WispaceDataCache();
    const calendarCalls = jest.fn();
    const scoreCalls = jest.fn();

    await cache.getOrFetch(
      'calendar',
      'user-1',
      undefined,
      fetcher('cal', calendarCalls),
    );
    await cache.getOrFetch(
      'scores',
      'user-1',
      undefined,
      fetcher('score', scoreCalls),
    );

    now += WISPACE_CACHE_POLICY.calendar + 1;

    await cache.getOrFetch(
      'calendar',
      'user-1',
      undefined,
      fetcher('cal', calendarCalls),
    );
    await cache.getOrFetch(
      'scores',
      'user-1',
      undefined,
      fetcher('score', scoreCalls),
    );

    expect(calendarCalls).toHaveBeenCalledTimes(2);
    expect(scoreCalls).toHaveBeenCalledTimes(1);
  });

  it('keys on the semantic args — different args fetch separately', async () => {
    const cache = new WispaceDataCache();
    const calls = jest.fn();

    await cache.getOrFetch(
      'calendar',
      'user-1',
      { timeRange: 'upcoming', limit: 5 },
      fetcher('a', calls),
    );
    await cache.getOrFetch(
      'calendar',
      'user-1',
      { timeRange: 'past', limit: 5 },
      fetcher('b', calls),
    );
    await cache.getOrFetch(
      'calendar',
      'user-1',
      { limit: 5, timeRange: 'upcoming' },
      fetcher('a', calls),
    );

    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('ignores undefined arg values in the key', async () => {
    const cache = new WispaceDataCache();
    const calls = jest.fn();

    await cache.getOrFetch(
      'calendar',
      'user-1',
      { timeRange: 'upcoming' },
      fetcher('a', calls),
    );
    await cache.getOrFetch(
      'calendar',
      'user-1',
      { timeRange: 'upcoming', pastDays: undefined },
      fetcher('a', calls),
    );

    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('invalidateUser forces the next read to refetch (read-your-writes)', async () => {
    const cache = new WispaceDataCache();
    const calls = jest.fn();

    await cache.getOrFetch('goals', 'user-1', undefined, fetcher('v1', calls));
    cache.invalidateUser('user-1');
    await cache.getOrFetch('goals', 'user-1', undefined, fetcher('v2', calls));

    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('invalidateUser can target a single kind', async () => {
    const cache = new WispaceDataCache();
    const goalCalls = jest.fn();
    const calCalls = jest.fn();

    await cache.getOrFetch(
      'goals',
      'user-1',
      undefined,
      fetcher('g', goalCalls),
    );
    await cache.getOrFetch(
      'calendar',
      'user-1',
      undefined,
      fetcher('c', calCalls),
    );

    cache.invalidateUser('user-1', ['calendar']);

    await cache.getOrFetch(
      'goals',
      'user-1',
      undefined,
      fetcher('g', goalCalls),
    );
    await cache.getOrFetch(
      'calendar',
      'user-1',
      undefined,
      fetcher('c', calCalls),
    );

    expect(goalCalls).toHaveBeenCalledTimes(1);
    expect(calCalls).toHaveBeenCalledTimes(2);
  });

  it('does not leak cache across users', async () => {
    const cache = new WispaceDataCache();
    const callsA = jest.fn();
    const callsB = jest.fn();

    await cache.getOrFetch('goals', 'user-1', undefined, fetcher('a', callsA));
    await cache.getOrFetch('goals', 'user-2', undefined, fetcher('b', callsB));
    cache.invalidateUser('user-1');
    await cache.getOrFetch('goals', 'user-2', undefined, fetcher('b', callsB));

    expect(callsA).toHaveBeenCalledTimes(1);
    expect(callsB).toHaveBeenCalledTimes(1);
  });

  it('evicts expired then oldest entries at the cap', async () => {
    const cache = new WispaceDataCache({ maxEntries: 2 });

    await cache.getOrFetch('goals', 'user-1', undefined, fetcher('v1'));
    await cache.getOrFetch('goals', 'user-2', undefined, fetcher('v2'));
    now += WISPACE_CACHE_POLICY.goals + 1;
    // user-1 and user-2 entries are expired — a third insert must not evict
    // a live entry (there is none) and the cache stays bounded.
    await cache.getOrFetch('goals', 'user-3', undefined, fetcher('v3'));
    await cache.getOrFetch('goals', 'user-4', undefined, fetcher('v4'));

    const callsOldest = jest.fn();
    // user-1 was evicted — reading it again must hit the fetcher.
    await cache.getOrFetch(
      'goals',
      'user-1',
      undefined,
      fetcher('x', callsOldest),
    );
    expect(callsOldest).toHaveBeenCalledTimes(1);
  });
});
