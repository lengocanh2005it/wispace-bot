import { MemoizedWispaceGoalsService } from './memoized-wispace-goals.service';
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
    const memo = new MemoizedWispaceGoalsService(delegate, { ttlMs: 60_000 });

    await memo.getUserGoals('user-1');
    await memo.getUserGoals('user-1');
    await memo.getUserGoals('user-1');

    expect(getUserGoals).toHaveBeenCalledTimes(1);
  });

  it('refetches after TTL expiry', async () => {
    jest.useFakeTimers();
    try {
      const { delegate, getUserGoals } = createDelegate();
      getUserGoals.mockResolvedValue(GOALS);
      const memo = new MemoizedWispaceGoalsService(delegate, {
        ttlMs: 10_000,
      });

      await memo.getUserGoals('user-1');
      jest.advanceTimersByTime(10_001);
      await memo.getUserGoals('user-1');

      expect(getUserGoals).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('caches per user — different users hit upstream separately', async () => {
    const { delegate, getUserGoals } = createDelegate();
    getUserGoals.mockResolvedValue(GOALS);
    const memo = new MemoizedWispaceGoalsService(delegate, { ttlMs: 60_000 });

    await memo.getUserGoals('user-a');
    await memo.getUserGoals('user-b');
    await memo.getUserGoals('user-a');

    expect(getUserGoals).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry when over maxEntries', async () => {
    const { delegate, getUserGoals } = createDelegate();
    getUserGoals.mockResolvedValue(GOALS);
    const memo = new MemoizedWispaceGoalsService(delegate, {
      ttlMs: 60_000,
      maxEntries: 2,
    });

    await memo.getUserGoals('u1');
    await memo.getUserGoals('u2');
    await memo.getUserGoals('u3'); // evicts u1 (oldest)
    await memo.getUserGoals('u1'); // refetch

    expect(getUserGoals).toHaveBeenCalledTimes(4);
  });

  it('delegates task score averages without caching', async () => {
    const { delegate, getTaskScoreAverages } = createDelegate();
    getTaskScoreAverages.mockResolvedValue([]);
    const memo = new MemoizedWispaceGoalsService(delegate, { ttlMs: 60_000 });

    await memo.getTaskScoreAverages('user-1');
    await memo.getTaskScoreAverages('user-1');

    expect(getTaskScoreAverages).toHaveBeenCalledTimes(2);
  });
});
