import { DataSource } from 'typeorm';
import { TypeormOpsHealthRepository } from './typeorm-ops-health.repository';

function buildRepo(
  platform: string,
  dailyLimit: () => number,
  query: jest.Mock,
): TypeormOpsHealthRepository {
  return new TypeormOpsHealthRepository(
    { query } as never as DataSource,
    platform,
    dailyLimit,
  );
}

type QueryCall = [sql: string, params: unknown[]];

describe('TypeormOpsHealthRepository', () => {
  it('queries all three chat quota summaries with the platform param', async () => {
    const query = jest.fn().mockResolvedValue([{ count: 3 }]);
    const repo = buildRepo('discord', () => 15, query);

    const summary = await repo.getChatQuotaSummary();

    expect(summary).toEqual({
      denyLogs24h: 3,
      stuckReserved: 3,
      usersAtDailyLimit: 3,
    });
    const calls = query.mock.calls as unknown as QueryCall[];
    expect(calls).toHaveLength(3);
    for (const [, params] of calls) {
      expect(params[0]).toBe('discord');
    }
  });

  it('passes the resolved daily limit into the users-at-limit query', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const dailyLimit = jest.fn().mockReturnValue(42);
    const repo = buildRepo('zalo', dailyLimit, query);

    await repo.getChatQuotaSummary();

    const calls = query.mock.calls as unknown as QueryCall[];
    const dailyQuery = calls.find(([sql]) => sql.includes('chat_daily_usage'));
    expect(dailyLimit).toHaveBeenCalledTimes(1);
    expect(dailyQuery?.[1]).toEqual(['zalo', expect.any(String), 42]);
  });

  it('aggregates study reminder counts by status', async () => {
    const query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('GROUP BY status')) {
        return Promise.resolve([
          { status: 'pending', count: 2 },
          { status: 'sent', count: 5 },
        ]);
      }
      return Promise.resolve([{ count: 1 }]);
    });
    const repo = buildRepo('zalo', () => 15, query);

    const summary = await repo.getStudyReminderSummary();

    expect(summary.countsByStatus).toEqual({ pending: 2, sent: 5 });
    expect(summary.terminalFailedSince).toBe(1);
    expect(summary.stuckProcessing).toBe(1);
  });
});
