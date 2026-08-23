/* eslint-disable @typescript-eslint/no-unsafe-assignment -- jest.fn() mock of global.fetch */
import { TaskScoreAverageApiClient } from './task-score-average-api.client';

function buildBodyMock(text: string) {
  const bytes = new TextEncoder().encode(text);
  let read = false;
  return {
    body: {
      getReader: () => ({
        read: jest.fn().mockImplementation(() => {
          if (read) return Promise.resolve({ done: true, value: undefined });
          read = true;
          return Promise.resolve({ done: false, value: bytes });
        }),
        cancel: jest.fn(),
        releaseLock: jest.fn(),
      }),
    },
  };
}

const VALID_RECORD = {
  id: 1,
  userId: 10,
  task: 'Task 1',
  avgTaskAchievement: 7,
  avgCoherenceCohesion: 7,
  avgLexicalResource: 7,
  avgGrammaticalRangeAccuracy: 7,
  avgTotalScore: 7,
  task1Count: 1,
  task2Count: 1,
  totalTasks: 2,
  currentStreak: 1,
  highestStreak: 1,
  totalPracticeTimeMinutes: 60,
};

describe('TaskScoreAverageApiClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('fetches task scores within 64KB array limit', async () => {
    const data = [VALID_RECORD];
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      ...buildBodyMock(JSON.stringify(data)),
      json: () => Promise.resolve(data),
    });
    global.fetch = fetchMock;

    const client = new TaskScoreAverageApiClient({
      url: 'https://backend.example.com/api/TaskScoreAverage',
      internalKey: 'internal-key',
    });

    const result = await client.getTaskScoreAverages('x-psid', 'psid-1');
    expect(result).toHaveLength(1);
  });

  it('rejects array response exceeding 64KB limit', async () => {
    const oversized = Array.from({ length: 10 }, (_, i) => ({
      ...VALID_RECORD,
      id: i,
      task: 'x'.repeat(20 * 1024),
    }));
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      ...buildBodyMock(JSON.stringify(oversized)),
      json: () => Promise.resolve(oversized),
    });
    global.fetch = fetchMock;

    const client = new TaskScoreAverageApiClient({
      url: 'https://backend.example.com/api/TaskScoreAverage',
      internalKey: 'internal-key',
    });

    await expect(
      client.getTaskScoreAverages('x-psid', 'psid-1'),
    ).rejects.toThrow();
  });

  it('rejects malformed JSON in response body', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      ...buildBodyMock('{ broken'),
      json: () => Promise.reject(new Error('not json')),
    });
    global.fetch = fetchMock;

    const client = new TaskScoreAverageApiClient({
      url: 'https://backend.example.com/api/TaskScoreAverage',
      internalKey: 'internal-key',
    });

    await expect(
      client.getTaskScoreAverages('x-psid', 'psid-1'),
    ).rejects.toThrow(/not valid JSON/);
  });
});
