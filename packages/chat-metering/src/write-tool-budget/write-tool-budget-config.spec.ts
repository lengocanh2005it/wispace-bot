import { readWriteToolBudgetConfig } from './write-tool-budget-config';

const from = (map: Record<string, string>) => (k: string) => map[k];

describe('readWriteToolBudgetConfig', () => {
  it('applies documented defaults when nothing is set', () => {
    const cfg = readWriteToolBudgetConfig(() => undefined);
    expect(cfg.enabled).toBe(true);
    expect(cfg.timezone).toBe('Asia/Ho_Chi_Minh');
    expect(cfg.dailyCaps).toEqual({
      reschedule_study_session: 8,
      precreate_next_exercise: 15,
    });
    expect(cfg.perMessageCaps).toEqual({
      reschedule_study_session: 1,
      precreate_next_exercise: 3,
    });
    expect(cfg.whitelist.size).toBe(0);
  });

  it('only false/0/no disables', () => {
    expect(
      readWriteToolBudgetConfig(
        from({ CHAT_WRITE_TOOL_BUDGET_ENABLED: 'false' }),
      ).enabled,
    ).toBe(false);
    expect(
      readWriteToolBudgetConfig(from({ CHAT_WRITE_TOOL_BUDGET_ENABLED: '0' }))
        .enabled,
    ).toBe(false);
    expect(
      readWriteToolBudgetConfig(
        from({ CHAT_WRITE_TOOL_BUDGET_ENABLED: 'true' }),
      ).enabled,
    ).toBe(true);
    expect(
      readWriteToolBudgetConfig(
        from({ CHAT_WRITE_TOOL_BUDGET_ENABLED: 'anything' }),
      ).enabled,
    ).toBe(true);
  });

  it('reads overrides and parses the whitelist', () => {
    const cfg = readWriteToolBudgetConfig(
      from({
        CHAT_WRITE_TOOL_DAILY_CAP_PRECREATE: '30',
        CHAT_WRITE_TOOL_PER_MESSAGE_CAP_RESCHEDULE: '2',
        CHAT_USAGE_TIMEZONE: 'UTC',
        CHAT_RATE_LIMIT_WHITELIST_PSIDS: 'a, b ,c',
      }),
    );
    expect(cfg.dailyCaps.precreate_next_exercise).toBe(30);
    expect(cfg.perMessageCaps.reschedule_study_session).toBe(2);
    expect(cfg.timezone).toBe('UTC');
    expect([...cfg.whitelist]).toEqual(['a', 'b', 'c']);
  });

  it('ignores non-positive / non-numeric overrides', () => {
    const cfg = readWriteToolBudgetConfig(
      from({
        CHAT_WRITE_TOOL_DAILY_CAP_PRECREATE: '-4',
        CHAT_WRITE_TOOL_DAILY_CAP_RESCHEDULE: 'x',
      }),
    );
    expect(cfg.dailyCaps.precreate_next_exercise).toBe(15);
    expect(cfg.dailyCaps.reschedule_study_session).toBe(8);
  });
});
