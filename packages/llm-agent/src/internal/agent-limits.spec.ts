import { AgentLimits } from './agent-limits';

describe('AgentLimits', () => {
  it('gives a valid maxInputTokens precedence over character settings', () => {
    const limits = new AgentLimits({
      maxInputTokens: 321.9,
      maxContextChars: 100_000,
    });

    expect(limits.inputTokenBudget).toBe(321);
  });

  it('converts maxContextChars to the token budget exactly once when needed', () => {
    const limits = new AgentLimits({ maxContextChars: 900 });

    expect(limits.inputTokenBudget).toBe(603);
  });

  it('uses bounded defaults for invalid values', () => {
    const limits = new AgentLimits({
      maxToolRounds: 0,
      maxToolCallsPerRound: Number.NaN,
      maxInputTokens: -1,
    });

    expect(limits.maxToolRounds).toBe(6);
    expect(limits.maxToolCallsPerRound).toBe(4);
    expect(limits.inputTokenBudget).toBe(Math.floor(24_000 * 0.67));
  });

  it('normalizes the stale observation threshold as a positive integer', () => {
    expect(
      new AgentLimits({ staleObservationRounds: 4 }).staleObservationRounds,
    ).toBe(4);
    expect(
      new AgentLimits({ staleObservationRounds: 4.5 }).staleObservationRounds,
    ).toBe(2);
    expect(
      new AgentLimits({ staleObservationRounds: 0 }).staleObservationRounds,
    ).toBe(2);
    expect(
      new AgentLimits({ staleObservationRounds: Number.NaN })
        .staleObservationRounds,
    ).toBe(2);
  });
});
