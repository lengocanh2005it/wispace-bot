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

  it('queries webhook inbound summary correctly', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        pending_count: 5,
        failed_count: 2,
        stuck_processing_count: 1,
        oldest_pending_age_seconds: 120,
      },
    ]);
    const repo = buildRepo('messenger', () => 15, query);

    const summary = await repo.getWebhookInboundSummary();

    expect(summary).toEqual({
      pendingCount: 5,
      failedCount: 2,
      stuckProcessingCount: 1,
      oldestPendingAgeSeconds: 120,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM webhook_inbound_events'),
      ['messenger'],
    );
  });

  it('queries dead letter summary correctly', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        pending_count: 3,
        failed_count: 1,
        oldest_pending_age_seconds: 300,
      },
    ]);
    const repo = buildRepo('discord', () => 15, query);

    const summary = await repo.getDeadLetterSummary();

    expect(summary).toEqual({
      outboundPendingCount: 3,
      outboundFailedCount: 1,
      oldestPendingAgeSeconds: 300,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM webhook_dead_letters'),
      ['discord'],
    );
  });

  it('queries LLM safety warnings with passed since date', async () => {
    const query = jest.fn().mockResolvedValue([{ count: 7 }]);
    const repo = buildRepo('zalo', () => 15, query);
    const since = new Date('2026-08-27T00:00:00.000Z');

    const count = await repo.getLlmSafetyWarningsCount(since);

    expect(count).toBe(7);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        'FROM llm_safety_events WHERE platform = $1 AND created_at > $2',
      ),
      ['zalo', since],
    );
  });
});
