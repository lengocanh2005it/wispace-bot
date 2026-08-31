import { TaskScoreAverageApiService } from './task-score-average-api.service';
import {
  MemoizedWispaceGoalsService,
  WispaceDataCache,
} from '@wispace/wispace-client';
import type { ConfigService } from '@nestjs/config';

describe('TaskScoreAverageApiService', () => {
  const buildService = () => {
    const signal = new AbortController().signal;
    const getTaskScoreAverages = jest.fn().mockResolvedValue([
      {
        id: 1,
        userId: 10,
        task: 'Task 1',
        avgTaskAchievement: 6,
        avgCoherenceCohesion: 6,
        avgLexicalResource: 6,
        avgGrammaticalRangeAccuracy: 6,
        avgTotalScore: 6.25,
        task1Count: 3,
        task2Count: 0,
        totalTasks: 3,
        currentStreak: 1,
        highestStreak: 1,
        totalPracticeTimeMinutes: 30,
      },
    ]);
    const getUserGoals = jest.fn().mockResolvedValue({
      targetScore: 7,
      examDate: '2026-09-01',
    });
    // The service consumes the shared memoizer facade (#456) — the same
    // wrapper the reminder/report ports bind, so goals collapse into one
    // upstream fetch per user per TTL window.
    const memoizedGoals = new MemoizedWispaceGoalsService(
      { getUserGoals } as never,
      new WispaceDataCache(),
    );
    const service = new TaskScoreAverageApiService(
      { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
      memoizedGoals,
    );
    (service as unknown as { getClient: () => unknown }).getClient = () => ({
      getTaskScoreAverages,
    });
    return { service, getTaskScoreAverages, getUserGoals, signal };
  };

  it('keeps missing task facts unknown instead of converting them to zero', async () => {
    const { service, getTaskScoreAverages, getUserGoals, signal } =
      buildService();

    const result = await service.getCapacityData('psid-1', { signal });

    expect(result.task1_band).toBe(6.3);
    expect(result.task2_band).toBeNull();
    expect(result.total_essays_task1).toBe(3);
    expect(result.total_essays_task2).toBeNull();
    expect(getTaskScoreAverages).toHaveBeenCalledWith('x-psid', 'psid-1', {
      signal,
    });
    expect(getUserGoals).toHaveBeenCalledWith('psid-1', { signal });
  });

  it('collapses repeated goals fetches into one upstream call within the TTL window (#456)', async () => {
    const { service, getUserGoals } = buildService();

    await service.getCapacityData('psid-1');
    await service.getCapacityData('psid-1');

    expect(getUserGoals).toHaveBeenCalledTimes(1);
  });

  it('fetches task scores and goals in parallel (independent inputs, #456)', async () => {
    const { service, getTaskScoreAverages, getUserGoals } = buildService();

    // Deferred promises: neither leg resolves until the test releases it.
    let releaseScores!: () => void;
    let releaseGoals!: () => void;
    const scoresGate = new Promise<void>((resolve) => {
      releaseScores = resolve;
    });
    const goalsGate = new Promise<void>((resolve) => {
      releaseGoals = resolve;
    });
    getTaskScoreAverages.mockImplementation(() =>
      scoresGate.then(() => [
        {
          id: 1,
          userId: 10,
          task: 'Task 1',
          avgTaskAchievement: 6,
          avgCoherenceCohesion: 6,
          avgLexicalResource: 6,
          avgGrammaticalRangeAccuracy: 6,
          avgTotalScore: 6.25,
          task1Count: 3,
          task2Count: 0,
          totalTasks: 3,
          currentStreak: 1,
          highestStreak: 1,
          totalPracticeTimeMinutes: 30,
        },
      ]),
    );
    getUserGoals.mockImplementation(() =>
      goalsGate.then(() => ({ targetScore: 7, examDate: '2026-09-01' })),
    );

    const pending = service.getCapacityData('psid-1');
    // Both legs must already be in flight before either resolves.
    await Promise.resolve();
    expect(getUserGoals).toHaveBeenCalledWith('psid-1', undefined);

    releaseGoals();
    releaseScores();
    await pending;
  });
});
