import { NOOP_METRICS_PORT } from '../ports';
import type { LlmAgentInput } from '../types';
import { AgentLimits } from './agent-limits';
import { ToolRoundExecutor } from './tool-round-executor';

const input: LlmAgentInput = {
  externalUserId: 'test-user',
  userText: 'Xem mục tiêu của mình',
  systemPrompt: 'system',
};

describe('ToolRoundExecutor', () => {
  it('deduplicates identical calls while preserving one result per id', async () => {
    const execute = jest.fn().mockResolvedValue({ targetScore: 6.5 });
    const executor = new ToolRoundExecutor(
      new AgentLimits({ toolExecutionTimeoutMs: 1_000 }),
      { execute },
      NOOP_METRICS_PORT,
      { warn: jest.fn() },
    );

    const result = await executor.execute(
      [
        { id: 'a', name: 'get_user_goals', arguments: '{}' },
        { id: 'b', name: 'get_user_goals', arguments: '{}' },
      ],
      input,
      {},
      2_000,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.executedCount).toBe(1);
    expect(result.successfulToolNames).toEqual(['get_user_goals']);
    expect(result.results).toHaveLength(2);
    expect(result.results.map((item) => item.toolCallId)).toEqual(['a', 'b']);
  });

  it('runs read-only calls in parallel', async () => {
    let active = 0;
    let maxActive = 0;
    const execute = jest.fn().mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return {};
    });
    const executor = new ToolRoundExecutor(
      new AgentLimits({ toolExecutionTimeoutMs: 1_000 }),
      { execute },
      NOOP_METRICS_PORT,
      { warn: jest.fn() },
    );

    const result = await executor.execute(
      [
        { id: 'a', name: 'get_user_goals', arguments: '{}' },
        { id: 'b', name: 'get_upcoming_study_sessions', arguments: '{}' },
      ],
      input,
      {},
      2_000,
    );

    expect(maxActive).toBe(2);
    expect(result.executedCount).toBe(2);
  });
});
