import { TaskScoreAverageApiService } from './task-score-average-api.service';
import type { UserGoalsApiService } from './user-goals-api.service';
import type { ConfigService } from '@nestjs/config';

describe('TaskScoreAverageApiService', () => {
  it('keeps missing task facts unknown instead of converting them to zero', async () => {
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
    const service = new TaskScoreAverageApiService(
      { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
      {
        getUserGoals,
        parseExamDate: (value: string) => value,
      } as unknown as UserGoalsApiService,
    );
    (service as unknown as { getClient: () => unknown }).getClient = () => ({
      getTaskScoreAverages,
    });

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
});
