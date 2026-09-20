import {
  addCostUsdStrings,
  buildInputCostEnvKey,
  buildProviderInputCostEnvKey,
  estimateCostUsd,
  normalizeModelForEnvKey,
} from './cost.utils';

describe('llm-usage cost.utils', () => {
  it('normalizes model names for env keys', () => {
    expect(normalizeModelForEnvKey('gpt-5.4')).toBe('GPT_5_4');
    expect(buildInputCostEnvKey('gpt-5.4')).toBe(
      'LLM_COST_USD_PER_1M_INPUT_TOKENS_GPT_5_4',
    );
    expect(
      buildProviderInputCostEnvKey('openrouter', 'openai/gpt-4o-mini'),
    ).toBe('LLM_COST_USD_PER_1M_INPUT_TOKENS_OPENROUTER_OPENAI_GPT_4O_MINI');
  });

  it('estimates USD from per-1M rates', () => {
    expect(estimateCostUsd(1_000_000, 500_000, 2.5, 10)).toBe('7.500000');
  });

  it('returns null when pricing is missing', () => {
    expect(estimateCostUsd(100, 50, null, 10)).toBeNull();
  });

  it('adds cost strings', () => {
    expect(addCostUsdStrings('1.500000', '2.250000')).toBe('3.750000');
    expect(addCostUsdStrings(null, null)).toBeNull();
  });
});
