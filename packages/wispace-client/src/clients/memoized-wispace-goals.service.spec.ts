import { MemoizedWispaceGoalsService } from './memoized-wispace-goals.service';
import { WispaceDataCache } from '../cache/wispace-data-cache';
import { WISPACE_CACHE_POLICY } from '../cache/wispace-cache-policy';
import type { WispaceGoalsService } from './wispace-goals.service';
import type { UserGoalsRecord } from '../types/user-goals.types';

const GOALS: UserGoalsRecord = { targetScore: 7, examDate: '2026-09-01' };

describe('MemoizedWispaceGoalsService', () => {
  const createDelegate = () => {
    const getUserGoals = jest.fn();
    const getTaskScoreAverages = jest.fn();
    return {
      delegate: {
        getUserGoals,
        getTaskScoreAverages,
      } as unknown as WispaceGoalsService,
      getUserGoals,
      getTaskScoreAverages,
    };
  };

  it('returns cached goals within TTL — one upstream call per user', async () => {
    const { delegate, getUserGoals } = createDelegate();
    getUserGoals.mockResolvedValue(GOALS);
    const memo = new MemoizedWispaceGoalsService(
      delegate,
      new WispaceDataCache(),
    );

    await memo.getUserGoals('user-1');
    await memo.getUserGoals('user-1');
    await memo.getUserGoals('user-1');

    expect(getUserGoals).toHaveBeenCalledTimes(1);
  });

  it('refetches after the policy TTL expiry', async () => {
    const now = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const { delegate, getUserGoals } = createDelegate();
      getUserGoals.mockResolvedValue(GOALS);
      const memo = new MemoizedWispaceGoalsService(
        delegate,
        new WispaceDataCache(),
      );

      await memo.getUserGoals('user-1');
      nowSpy.mockReturnValue(now + WISPACE_CACHE_POLICY.goals + 1);
      await memo.getUserGoals('user-1');

      expect(getUserGoals).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('caches per user — different users hit upstream separately', async () => {
    const { delegate, getUserGoals } = createDelegate();
    getUserGoals.mockResolvedValue(GOALS);
    const memo = new MemoizedWispaceGoalsService(
      delegate,
      new WispaceDataCache(),
    );

    await memo.getUserGoals('user-a');
    await memo.getUserGoals('user-b');
    await memo.getUserGoals('user-a');

    expect(getUserGoals).toHaveBeenCalledTimes(2);
  });

  it('invalidation forces a refetch — read-your-writes (#636)', async () => {
    const { delegate, getUserGoals } = createDelegate();
    getUserGoals.mockResolvedValue(GOALS);
    const cache = new WispaceDataCache();
    const memo = new MemoizedWispaceGoalsService(delegate, cache);

    await memo.getUserGoals('user-1');
    cache.invalidateUser('user-1');
    await memo.getUserGoals('user-1');

    expect(getUserGoals).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry when over maxEntries', async () => {
    const { delegate, getUserGoals } = createDelegate();
    getUserGoals.mockResolvedValue(GOALS);
    const memo = new MemoizedWispaceGoalsService(
      delegate,
      new WispaceDataCache({ maxEntries: 2 }),
    );

    await memo.getUserGoals('u1');
    await memo.getUserGoals('u2');
    await memo.getUserGoals('u3'); // evicts u1 (oldest)
    await memo.getUserGoals('u1'); // refetch

    expect(getUserGoals).toHaveBeenCalledTimes(4);
  });

  it('delegates task score averages without caching', async () => {
    const { delegate, getTaskScoreAverages } = createDelegate();
    getTaskScoreAverages.mockResolvedValue([]);
    const memo = new MemoizedWispaceGoalsService(
      delegate,
      new WispaceDataCache(),
    );

    await memo.getTaskScoreAverages('user-1');
    await memo.getTaskScoreAverages('user-1');

    expect(getTaskScoreAverages).toHaveBeenCalledTimes(2);
  });
});
