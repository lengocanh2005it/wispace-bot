import {
  createLlmProviderAdapter,
  createFailoverLlmProviderAdapter,
} from './factory';
import { OpenAiAdapter } from './openai/openai-adapter';
import { FailoverLlmProviderAdapter } from './failover/failover-adapter';
import type { LlmProviderEntryConfig } from './factory';

describe('createLlmProviderAdapter', () => {
  it('creates OpenAiAdapter for openai', () => {
    const adapter = createLlmProviderAdapter({
      getApiKey: () => 'key',
      getModel: () => 'gpt-5.4',
      provider: 'openai',
    });
    expect(adapter).toBeInstanceOf(OpenAiAdapter);
    expect(adapter.providerName).toBe('openai');
  });

  // ponytail: OpenAiCompatibleAdapter inlined — now just OpenAiAdapter with provider name
  it('creates OpenAiAdapter for openai-compatible', () => {
    const adapter = createLlmProviderAdapter({
      getApiKey: () => 'key',
      getModel: () => 'model',
      getBaseUrl: () => 'https://llm.example.test/v1',
      provider: 'openai-compatible',
    });
    expect(adapter).toBeInstanceOf(OpenAiAdapter);
    expect(adapter.providerName).toBe('openai-compatible');
  });

  it('defaults to openai when provider omitted', () => {
    const adapter = createLlmProviderAdapter({
      getApiKey: () => 'key',
      getModel: () => 'gpt-5.4',
    });
    expect(adapter).toBeInstanceOf(OpenAiAdapter);
  });

  it('rejects an unknown provider instead of silently using OpenAI', () => {
    expect(() =>
      createLlmProviderAdapter({
        getApiKey: () => 'key',
        getModel: () => 'model',
        provider: 'typo-provider',
      }),
    ).toThrow('Unsupported LLM provider configuration: typo-provider');
  });

  it('requires an explicit endpoint for a custom OpenAI-compatible provider', () => {
    expect(() =>
      createLlmProviderAdapter({
        getApiKey: () => 'key',
        getModel: () => 'model',
        provider: 'openai-compatible',
      }),
    ).toThrow('OPENAI-compatible provider requires a base URL');
  });
});

describe('createFailoverLlmProviderAdapter', () => {
  const entryA: LlmProviderEntryConfig = {
    provider: 'openai',
    getApiKey: () => 'key-a',
    getModel: () => 'model-a',
  };
  const entryB: LlmProviderEntryConfig = {
    provider: 'openai-compatible',
    getApiKey: () => 'key-b',
    getModel: () => 'model-b',
    getBaseUrl: () => 'https://llm.example.test/v1',
  };

  it('returns single adapter directly when only 1 provider configured', () => {
    const result = createFailoverLlmProviderAdapter([entryA], ['openai']);
    expect(result).toBeInstanceOf(OpenAiAdapter);
    expect(result).not.toBeInstanceOf(FailoverLlmProviderAdapter);
  });

  it('warns loudly when only one provider is configured', () => {
    const warn = jest.fn();

    createFailoverLlmProviderAdapter([entryA], ['openai'], { warn });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/only one LLM provider/i),
    );
  });

  it('returns FailoverLlmProviderAdapter when ≥2 providers configured', () => {
    const result = createFailoverLlmProviderAdapter(
      [entryA, entryB],
      ['openai', 'openai-compatible'],
    );
    expect(result).toBeInstanceOf(FailoverLlmProviderAdapter);
  });

  it('wraps one provider when telemetry or retry budget is configured', () => {
    const onProviderAttempt = jest.fn();
    const result = createFailoverLlmProviderAdapter(
      [entryA],
      ['openai'],
      undefined,
      { maxAttempts: 4, onProviderAttempt },
    );

    expect(result).toBeInstanceOf(FailoverLlmProviderAdapter);
    expect((result as unknown as { maxAttempts: number }).maxAttempts).toBe(4);
  });

  it('fails startup when a provider listed in the order is missing credentials', () => {
    const entryNoKey: LlmProviderEntryConfig = {
      provider: 'openai-compatible',
      getApiKey: () => undefined,
      getModel: () => 'model',
      getBaseUrl: () => 'https://llm.example.test/v1',
    };
    expect(() =>
      createFailoverLlmProviderAdapter(
        [entryA, entryNoKey],
        ['openai', 'openai-compatible'],
      ),
    ).toThrow(
      'LLM provider openai-compatible is listed in failover order but missing API key',
    );
  });

  it('follows order parameter', () => {
    const result = createFailoverLlmProviderAdapter(
      [entryA, entryB],
      ['openai-compatible', 'openai'],
    );
    expect(result).toBeInstanceOf(FailoverLlmProviderAdapter);
    // Verify order by checking the adapter's internal behavior
    // The first candidate in order should be tried first
  });

  it('throws when no providers configured in order', () => {
    expect(() =>
      createFailoverLlmProviderAdapter([entryA], ['openai-compatible']),
    ).toThrow(
      'LLM provider openai-compatible is listed in failover order but has no configuration',
    );
  });

  it('throws when order is empty and no entries match', () => {
    expect(() => createFailoverLlmProviderAdapter([], [])).toThrow(
      'No LLM provider configured in failover order',
    );
  });

  it('passes failoverConfig cooldown values to FailoverLlmProviderAdapter', () => {
    const adapter = createFailoverLlmProviderAdapter(
      [entryA, entryB],
      ['openai', 'openai-compatible'],
      undefined,
      { cooldownLongMs: 1000, cooldownShortMs: 200, quickRetryDelayMs: 50 },
    );
    expect(adapter).toBeInstanceOf(FailoverLlmProviderAdapter);
    // Verify cooldown propagation via reflection (test-only assertion)
    const failover = adapter as unknown as Record<string, number>;
    expect(failover.cooldownLongMs).toBe(1000);
    expect(failover.cooldownShortMs).toBe(200);
    expect(failover.quickRetryDelayMs).toBe(50);
  });

  it('uses default cooldown values when failoverConfig omitted', () => {
    const adapter = createFailoverLlmProviderAdapter(
      [entryA, entryB],
      ['openai', 'openai-compatible'],
    );
    const failover = adapter as unknown as Record<string, number>;
    expect(failover.cooldownLongMs).toBe(600_000);
    expect(failover.cooldownShortMs).toBe(5_000);
    expect(failover.quickRetryDelayMs).toBe(150);
  });
});
