import { WriteToolBudgetCore } from './write-tool-budget-core.service';
import type { WriteToolBudgetRepositoryPort } from './write-tool-budget.types';

const SETTINGS = {
  enabled: true,
  timezone: 'Asia/Ho_Chi_Minh',
  dailyCaps: { precreate_next_exercise: 15, reschedule_study_session: 8 },
  perMessageCaps: { precreate_next_exercise: 3, reschedule_study_session: 1 },
  whitelist: new Set<string>(['vip-1']),
};

function makeRepo(over: Partial<WriteToolBudgetRepositoryPort> = {}) {
  return {
    getDailyCount: jest.fn().mockResolvedValue(0),
    tryConsumeDaily: jest.fn().mockResolvedValue({ ok: true, count: 1 }),
    refundDaily: jest.fn().mockResolvedValue(undefined),
    ...over,
  } as jest.Mocked<WriteToolBudgetRepositoryPort>;
}

describe('WriteToolBudgetCore', () => {
  it('consumeDaily allows and calls the repo when under cap', async () => {
    const repo = makeRepo();
    const core = new WriteToolBudgetCore(repo, SETTINGS);
    await expect(
      core.consumeDaily('ext-1', 10, 'precreate_next_exercise'),
    ).resolves.toBe(true);
    expect(repo.tryConsumeDaily).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 10,
        dailyCap: 15,
        toolName: 'precreate_next_exercise',
      }),
    );
  });

  it('consumeDaily denies and fires onDenied when the cap is reached', async () => {
    const repo = makeRepo({
      tryConsumeDaily: jest.fn().mockResolvedValue({ ok: false, count: 15 }),
    });
    const onDenied = jest.fn();
    const core = new WriteToolBudgetCore(repo, SETTINGS, { onDenied });
    await expect(
      core.consumeDaily('ext-1', 10, 'precreate_next_exercise'),
    ).resolves.toBe(false);
    expect(onDenied).toHaveBeenCalledWith('precreate_next_exercise', 'daily');
  });

  it('bypasses whitelisted external ids without touching the repo', async () => {
    const repo = makeRepo();
    const core = new WriteToolBudgetCore(repo, SETTINGS);
    await expect(
      core.consumeDaily('vip-1', 10, 'precreate_next_exercise'),
    ).resolves.toBe(true);
    expect(repo.tryConsumeDaily).not.toHaveBeenCalled();
  });

  it('is a no-op passthrough when disabled', async () => {
    const repo = makeRepo();
    const core = new WriteToolBudgetCore(repo, { ...SETTINGS, enabled: false });
    await expect(
      core.consumeDaily('ext-1', 10, 'precreate_next_exercise'),
    ).resolves.toBe(true);
    await expect(
      core.checkDailyAllowed('ext-1', 10, 'reschedule_study_session'),
    ).resolves.toBe(true);
    expect(repo.tryConsumeDaily).not.toHaveBeenCalled();
    expect(repo.getDailyCount).not.toHaveBeenCalled();
  });

  it('checkDailyAllowed returns false and fires onDenied when confirmed count >= cap', async () => {
    const repo = makeRepo({ getDailyCount: jest.fn().mockResolvedValue(8) });
    const onDenied = jest.fn();
    const core = new WriteToolBudgetCore(repo, SETTINGS, { onDenied });
    await expect(
      core.checkDailyAllowed('ext-1', 10, 'reschedule_study_session'),
    ).resolves.toBe(false);
    expect(onDenied).toHaveBeenCalledWith('reschedule_study_session', 'daily');
  });

  it('treats an unbudgeted tool as always allowed', async () => {
    const repo = makeRepo();
    const core = new WriteToolBudgetCore(repo, SETTINGS);
    await expect(
      core.consumeDaily('ext-1', 10, 'some_other_tool'),
    ).resolves.toBe(true);
    expect(repo.tryConsumeDaily).not.toHaveBeenCalled();
  });

  it('refundDaily is a no-op when disabled or unbudgeted', async () => {
    const repo = makeRepo();
    const disabled = new WriteToolBudgetCore(repo, {
      ...SETTINGS,
      enabled: false,
    });
    await disabled.refundDaily(10, 'precreate_next_exercise');
    const enabled = new WriteToolBudgetCore(repo, SETTINGS);
    await enabled.refundDaily(10, 'unbudgeted_tool');
    expect(repo.refundDaily).not.toHaveBeenCalled();
  });
});
