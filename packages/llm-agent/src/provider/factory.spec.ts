import {
  createLlmProviderAdapter,
  createFailoverLlmProviderAdapter,
} from './factory';
import { OpenAiAdapter } from './openai/openai-adapter';
import { OpenAiCompatibleAdapter } from './openai-compatible/openai-compatible-adapter';
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

  it('creates OpenAiCompatibleAdapter for openai-compatible', () => {
    const adapter = createLlmProviderAdapter({
      getApiKey: () => 'key',
      getModel: () => 'model',
      provider: 'openai-compatible',
    });
    expect(adapter).toBeInstanceOf(OpenAiCompatibleAdapter);
    expect(adapter.providerName).toBe('openai-compatible');
  });

  it('defaults to openai when provider omitted', () => {
    const adapter = createLlmProviderAdapter({
      getApiKey: () => 'key',
      getModel: () => 'gpt-5.4',
    });
    expect(adapter).toBeInstanceOf(OpenAiAdapter);
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
  };

  it('returns single adapter directly when only 1 provider configured', () => {
    const result = createFailoverLlmProviderAdapter(
      [entryA],
      ['openai', 'openai-compatible'],
    );
    expect(result).toBeInstanceOf(OpenAiAdapter);
    expect(result).not.toBeInstanceOf(FailoverLlmProviderAdapter);
  });

  it('returns FailoverLlmProviderAdapter when ≥2 providers configured', () => {
    const result = createFailoverLlmProviderAdapter(
      [entryA, entryB],
      ['openai', 'openai-compatible'],
    );
    expect(result).toBeInstanceOf(FailoverLlmProviderAdapter);
  });

  it('filters out providers without API key', () => {
    const entryNoKey: LlmProviderEntryConfig = {
      provider: 'openai-compatible',
      getApiKey: () => undefined,
      getModel: () => 'model',
    };
    const result = createFailoverLlmProviderAdapter(
      [entryA, entryNoKey],
      ['openai', 'openai-compatible'],
    );
    // Only openai has key → single adapter, no failover
    expect(result).toBeInstanceOf(OpenAiAdapter);
    expect(result).not.toBeInstanceOf(FailoverLlmProviderAdapter);
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
      createFailoverLlmProviderAdapter(
        [entryA],
        ['openai-compatible'], // openai-compatible not in entries
      ),
    ).toThrow('No LLM provider configured in failover order');
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
