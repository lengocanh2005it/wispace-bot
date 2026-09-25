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

  it('records the effective limit for a capped tool result', async () => {
    const execute = jest.fn().mockResolvedValue({
      count: 10,
      capped: true,
      completeness: 'incomplete',
      effectiveLimit: 10,
    });
    const executor = new ToolRoundExecutor(
      new AgentLimits({ toolExecutionTimeoutMs: 1_000 }),
      { execute },
      NOOP_METRICS_PORT,
      { warn: jest.fn() },
    );

    const result = await executor.execute(
      [
        {
          id: 'a',
          name: 'get_upcoming_study_sessions',
          arguments: JSON.stringify({ limit: 15 }),
        },
      ],
      input,
      {},
      2_000,
    );

    expect(result.boundedToolDisclosures).toEqual(
      new Map([
        [
          'get_upcoming_study_sessions:{"limit":15}',
          {
            limit: 10,
            count: 10,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
    );
  });

  it('keeps over-limit and at-limit requests in separate disclosure scopes', async () => {
    const execute = jest
      .fn()
      .mockImplementation((_toolName: string, argsJson: string) => {
        const { limit } = JSON.parse(argsJson) as { limit: number };
        return Promise.resolve(
          limit > 10
            ? {
                count: 10,
                requestedLimit: limit,
                effectiveLimit: 10,
                capped: true,
                completeness: 'incomplete',
                sessions: [],
              }
            : {
                count: 5,
                effectiveLimit: 10,
                capped: false,
                completeness: 'unknown',
                sessions: [],
              },
        );
      });
    const executor = new ToolRoundExecutor(
      new AgentLimits({ toolExecutionTimeoutMs: 1_000 }),
      { execute },
      NOOP_METRICS_PORT,
      { warn: jest.fn() },
    );

    const result = await executor.execute(
      [
        {
          id: 'a',
          name: 'get_upcoming_study_sessions',
          arguments: JSON.stringify({ limit: 15 }),
        },
        {
          id: 'b',
          name: 'get_upcoming_study_sessions',
          arguments: JSON.stringify({ limit: 10 }),
        },
      ],
      input,
      {},
      2_000,
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.boundedToolDisclosures.size).toBe(2);
  });

  it('keeps an earlier cap when a later same-tool result is not capped', async () => {
    const execute = jest
      .fn()
      .mockImplementation((_toolName: string, argsJson: string) => {
        const { limit } = JSON.parse(argsJson) as { limit: number };
        return Promise.resolve(
          limit > 10
            ? {
                count: 10,
                requestedLimit: limit,
                effectiveLimit: 10,
                capped: true,
                completeness: 'incomplete',
              }
            : {
                count: 3,
                effectiveLimit: limit,
                capped: false,
                completeness: 'unknown',
              },
        );
      });
    const executor = new ToolRoundExecutor(
      new AgentLimits({ toolExecutionTimeoutMs: 1_000 }),
      { execute },
      NOOP_METRICS_PORT,
      { warn: jest.fn() },
    );

    const result = await executor.execute(
      [
        {
          id: 'a',
          name: 'get_upcoming_study_sessions',
          arguments: JSON.stringify({ limit: 15 }),
        },
        {
          id: 'b',
          name: 'get_upcoming_study_sessions',
          arguments: JSON.stringify({ limit: 3 }),
        },
      ],
      input,
      {},
      2_000,
    );

    expect(result.boundedToolDisclosures.size).toBe(2);
    expect(
      result.boundedToolDisclosures.get(
        'get_upcoming_study_sessions:{"limit":15}',
      ),
    ).toMatchObject({
      limit: 10,
      capped: true,
      completeness: 'incomplete',
    });
    expect(
      result.boundedToolDisclosures.get(
        'get_upcoming_study_sessions:{"limit":3}',
      ),
    ).toMatchObject({
      limit: 3,
      capped: false,
      completeness: 'unknown',
    });
  });

  it('reserves compact cap metadata when fitting a tiny observation budget', async () => {
    const execute = jest.fn().mockResolvedValue({
      count: 10,
      requestedLimit: 15,
      effectiveLimit: 10,
      capped: true,
      completeness: 'incomplete',
      sessions: Array.from({ length: 20 }, (_, index) => ({
        topic: 'x'.repeat(500),
        scheduledAtIso: '2026-09-01T08:00:00.000Z',
        index,
      })),
    });
    const executor = new ToolRoundExecutor(
      new AgentLimits({ toolExecutionTimeoutMs: 1_000 }),
      { execute },
      NOOP_METRICS_PORT,
      { warn: jest.fn() },
    );

    const result = await executor.execute(
      [
        {
          id: 'a',
          name: 'get_upcoming_study_sessions',
          arguments: JSON.stringify({ limit: 15 }),
        },
      ],
      input,
      {},
      120,
    );

    expect(result.results[0].content).toContain('"capped":true');
    expect(result.results[0].content).toContain('"completeness":"incomplete"');
    expect(result.results[0].content.length).toBeLessThanOrEqual(120);
  });

  it('reserves cap state for every parallel capped result', async () => {
    const execute = jest.fn().mockImplementation((toolName: string) =>
      Promise.resolve({
        count: 10,
        requestedLimit: 15,
        effectiveLimit: 10,
        requestedPastDays: 9999,
        effectivePastDays: 365,
        capped: true,
        completeness: 'incomplete',
        ...(toolName === 'list_study_calendar_entries'
          ? { timeRange: 'past', entries: [{ topic: 'x'.repeat(500) }] }
          : {
              timeRange: 'upcoming',
              sessions: [{ topic: 'x'.repeat(500) }],
            }),
      }),
    );
    const executor = new ToolRoundExecutor(
      new AgentLimits({ toolExecutionTimeoutMs: 1_000 }),
      { execute },
      NOOP_METRICS_PORT,
      { warn: jest.fn() },
    );

    const calls = [
      {
        id: 'a',
        name: 'get_upcoming_study_sessions',
        arguments: JSON.stringify({ limit: 15 }),
      },
      {
        id: 'b',
        name: 'list_study_calendar_entries',
        arguments: JSON.stringify({
          timeRange: 'past',
          limit: 15,
          pastDays: 9999,
        }),
      },
    ];
    const result = await executor.execute(calls, input, {}, 240);

    for (const observation of result.results) {
      expect(observation.content).toContain('"capped":true');
      expect(observation.content).toContain('"completeness":"incomplete"');
    }
    expect(
      result.results.find(
        (observation) => observation.toolName === 'list_study_calendar_entries',
      )?.content,
    ).toContain('"timeRange":"past"');

    const constrained = await executor.execute(calls, input, {}, 120);
    for (const observation of constrained.results) {
      expect(observation.content).toContain('"capped":true');
      expect(observation.content).toContain('"count":10');
    }
    expect(
      constrained.results.find(
        (observation) => observation.toolName === 'list_study_calendar_entries',
      )?.content,
    ).toContain('"timeRange":"past"');
    expect(
      constrained.results.find(
        (observation) => observation.toolName === 'list_study_calendar_entries',
      )?.content,
    ).toContain('"effectivePastDays":365');
  });

  it('does not exceed a very small observation budget', async () => {
    const execute = jest.fn().mockResolvedValue({
      count: 10,
      requestedLimit: 15,
      effectiveLimit: 10,
      capped: true,
      completeness: 'incomplete',
      sessions: [{ topic: 'x'.repeat(500) }],
    });
    const executor = new ToolRoundExecutor(
      new AgentLimits({ toolExecutionTimeoutMs: 1_000 }),
      { execute },
      NOOP_METRICS_PORT,
      { warn: jest.fn() },
    );

    const result = await executor.execute(
      [
        {
          id: 'a',
          name: 'get_upcoming_study_sessions',
          arguments: JSON.stringify({ limit: 15 }),
        },
      ],
      input,
      {},
      80,
    );

    expect(result.results[0].content.length).toBeLessThanOrEqual(80);
  });

  it('keeps output within a zero observation budget', async () => {
    const execute = jest.fn().mockResolvedValue({ sessions: [] });
    const executor = new ToolRoundExecutor(
      new AgentLimits({ toolExecutionTimeoutMs: 1_000 }),
      { execute },
      NOOP_METRICS_PORT,
      { warn: jest.fn() },
    );

    const result = await executor.execute(
      [{ id: 'a', name: 'get_user_goals', arguments: '{}' }],
      input,
      {},
      0,
    );

    expect(result.results[0].content.length).toBeLessThanOrEqual(0);
  });

  it('uses the past-day bound when that is the capped dimension', async () => {
    const execute = jest.fn().mockResolvedValue({
      count: 0,
      requestedPastDays: 9999,
      effectivePastDays: 365,
      effectiveLimit: 10,
      capped: true,
      completeness: 'incomplete',
    });
    const executor = new ToolRoundExecutor(
      new AgentLimits({ toolExecutionTimeoutMs: 1_000 }),
      { execute },
      NOOP_METRICS_PORT,
      { warn: jest.fn() },
    );

    const result = await executor.execute(
      [
        {
          id: 'a',
          name: 'list_study_calendar_entries',
          arguments: JSON.stringify({ timeRange: 'past', pastDays: 9999 }),
        },
      ],
      input,
      {},
      2_000,
    );

    expect(result.boundedToolDisclosures).toEqual(
      new Map([
        [
          'list_study_calendar_entries:{"pastDays":9999,"timeRange":"past"}',
          {
            limit: 10,
            pastDays: 365,
            requestedPastDays: 9999,
            count: 0,
            capped: true,
            completeness: 'incomplete',
          },
        ],
      ]),
    );
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
