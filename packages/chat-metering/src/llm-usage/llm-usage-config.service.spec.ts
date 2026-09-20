import { LlmUsageConfigService } from './llm-usage-config.service';

function service(values: Record<string, string>): LlmUsageConfigService {
  return new LlmUsageConfigService({
    get: (key: string) => values[key],
  } as never);
}

describe('LlmUsageConfigService provider-aware pricing', () => {
  it('uses provider+model rates for a failover chain', () => {
    const config = service({
      LLM_PROVIDER_FAILOVER_ORDER: 'openai,openrouter',
      LLM_COST_USD_PER_1M_INPUT_TOKENS_OPENROUTER_OPENAI_GPT_4O_MINI: '2',
      LLM_COST_USD_PER_1M_OUTPUT_TOKENS_OPENROUTER_OPENAI_GPT_4O_MINI: '10',
    });

    expect(
      config.estimateCostUsdForModel(
        'openai/gpt-4o-mini',
        1_000_000,
        500_000,
        0,
        'openrouter',
      ),
    ).toBe('7.000000');
  });

  it('keeps model-only rates for a single-provider process', () => {
    const config = service({
      LLM_COST_USD_PER_1M_INPUT_TOKENS_GPT_5_4: '2',
      LLM_COST_USD_PER_1M_OUTPUT_TOKENS_GPT_5_4: '10',
    });

    expect(
      config.estimateCostUsdForModel(
        'gpt-5.4',
        1_000_000,
        500_000,
        0,
        'openai',
      ),
    ).toBe('7.000000');
  });

  it('does not fall back to legacy model-only rates for a failover chain', () => {
    const config = service({
      LLM_PROVIDER_FAILOVER_ORDER: 'openai,openrouter',
      LLM_COST_USD_PER_1M_INPUT_TOKENS_GPT_5_4: '2',
      LLM_COST_USD_PER_1M_OUTPUT_TOKENS_GPT_5_4: '10',
    });

    expect(
      config.estimateCostUsdForModel('gpt-5.4', 100, 50, 0, 'openrouter'),
    ).toBeNull();
  });
});
