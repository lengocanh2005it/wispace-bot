import { InMemoryToolResultCache } from './in-memory-tool-result-cache';

describe('InMemoryToolResultCache', () => {
  it('returns undefined for cache miss', async () => {
    const cache = new InMemoryToolResultCache();
    await expect(cache.get('missing-key')).resolves.toBeUndefined();
  });

  it('returns value after set', async () => {
    const cache = new InMemoryToolResultCache();
    await cache.set('key', { data: 'test' }, 60_000);
    await expect(cache.get('key')).resolves.toEqual({ data: 'test' });
  });

  it('returns undefined after TTL expires', async () => {
    const cache = new InMemoryToolResultCache();
    await cache.set('key', { data: 'test' }, -1);
    await expect(cache.get('key')).resolves.toBeUndefined();
  });

  it('invalidate removes specific key', async () => {
    const cache = new InMemoryToolResultCache();
    await cache.set('key-a', 'a', 60_000);
    await cache.set('key-b', 'b', 60_000);
    await cache.invalidate('key-a');
    await expect(cache.get('key-a')).resolves.toBeUndefined();
    await expect(cache.get('key-b')).resolves.toBe('b');
  });

  it('invalidatePrefix removes all keys starting with prefix', async () => {
    const cache = new InMemoryToolResultCache();
    await cache.set('user123:list_study_calendar_entries:abc', 'x', 60_000);
    await cache.set('user123:list_study_calendar_entries:def', 'y', 60_000);
    await cache.set('user123:get_user_goals:ghi', 'z', 60_000);
    await cache.invalidatePrefix('user123:list_study_calendar_entries:');
    await expect(
      cache.get('user123:list_study_calendar_entries:abc'),
    ).resolves.toBeUndefined();
    await expect(
      cache.get('user123:list_study_calendar_entries:def'),
    ).resolves.toBeUndefined();
    await expect(cache.get('user123:get_user_goals:ghi')).resolves.toBe('z');
  });
});
