import { WriteToolBudgetRepository } from './write-tool-budget.repository';

function makeRepo(queryImpl: (sql: string, params: unknown[]) => unknown) {
  const query = jest.fn((sql: string, params: unknown[]) =>
    Promise.resolve(queryImpl(sql, params)),
  );
  const repo = { manager: { query } } as never;
  return { repo, query };
}

describe('WriteToolBudgetRepository', () => {
  it('tryConsumeDaily returns ok with countAfter when the upsert returns a row', async () => {
    const { repo } = makeRepo(() => [{ count: 3 }]);
    const sut = new WriteToolBudgetRepository(repo, 'discord');
    const result = await sut.tryConsumeDaily({
      externalUserId: 'ext-1',
      userId: 42,
      usageDate: '2026-08-31',
      toolName: 'precreate_next_exercise',
      dailyCap: 15,
    });
    expect(result).toEqual({ ok: true, count: 3 });
  });

  it('tryConsumeDaily returns not-ok when the upsert is blocked by the cap guard', async () => {
    const { repo } = makeRepo((sql) =>
      sql.includes('INSERT INTO chat_tool_daily_usage') ? [] : [{ count: 15 }],
    );
    const sut = new WriteToolBudgetRepository(repo, 'discord');
    const result = await sut.tryConsumeDaily({
      externalUserId: 'ext-1',
      userId: 42,
      usageDate: '2026-08-31',
      toolName: 'precreate_next_exercise',
      dailyCap: 15,
    });
    expect(result.ok).toBe(false);
    expect(result.count).toBe(15);
  });

  it('getDailyCount reads the row count, 0 when absent', async () => {
    const { repo } = makeRepo(() => []);
    const sut = new WriteToolBudgetRepository(repo, 'zalo');
    expect(
      await sut.getDailyCount(1, '2026-08-31', 'reschedule_study_session'),
    ).toBe(0);
  });

  it('refundDaily issues a GREATEST(count - 1, 0) update scoped by platform', async () => {
    const { repo, query } = makeRepo(() => []);
    const sut = new WriteToolBudgetRepository(repo, 'messenger');
    await sut.refundDaily({
      userId: 7,
      usageDate: '2026-08-31',
      toolName: 'precreate_next_exercise',
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('GREATEST');
    expect(sql).toContain('chat_tool_daily_usage');
    expect(params).toEqual([
      'messenger',
      7,
      '2026-08-31',
      'precreate_next_exercise',
    ]);
  });
});
