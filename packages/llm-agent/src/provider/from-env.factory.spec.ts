import { createLlmProviderAdapterFromEnv } from './from-env.factory';
import { FailoverLlmProviderAdapter } from './failover/failover-adapter';

describe('createLlmProviderAdapterFromEnv', () => {
  it('returns openai adapter when no failover order env is set', () => {
    const adapter = createLlmProviderAdapterFromEnv((key) =>
      key === 'OPENAI_API_KEY' ? 'key' : undefined,
    );
    expect(adapter).toBeInstanceOf(FailoverLlmProviderAdapter);
  });

  it('returns failover adapter when order env is set with multiple providers', () => {
    const adapter = createLlmProviderAdapterFromEnv((key) =>
      key === 'LLM_PROVIDER_FAILOVER_ORDER'
        ? 'openai, openrouter'
        : key === 'OPENAI_API_KEY' || key === 'OPENROUTER_API_KEY'
          ? 'key'
          : undefined,
    );
    expect(adapter).toBeInstanceOf(FailoverLlmProviderAdapter);
  });

  it('uses defaultProviderOrder when order env is empty', () => {
    const adapter = createLlmProviderAdapterFromEnv(
      (key) => (key === 'OPENAI_API_KEY' ? 'key' : undefined),
      { defaultProviderOrder: ['openai'] },
    );
    expect(adapter).toBeInstanceOf(FailoverLlmProviderAdapter);
  });

  it('passes the configured retry budget to the adapter', () => {
    const adapter = createLlmProviderAdapterFromEnv((key) => {
      if (key === 'OPENAI_API_KEY') return 'key';
      if (key === 'LLM_OPENAI_RETRY_MAX_ATTEMPTS') return '4';
      return undefined;
    });

    expect((adapter as unknown as { maxAttempts: number }).maxAttempts).toBe(4);
  });

  it('fails startup when an explicitly ordered provider has no key', () => {
    expect(() =>
      createLlmProviderAdapterFromEnv((key) =>
        key === 'LLM_PROVIDER_FAILOVER_ORDER'
          ? 'openai,openrouter'
          : key === 'OPENAI_API_KEY'
            ? 'key'
            : undefined,
      ),
    ).toThrow(/openrouter.*missing API key/i);
  });

  it('fails startup for an unknown provider name', () => {
    expect(() =>
      createLlmProviderAdapterFromEnv((key) =>
        key === 'LLM_PROVIDER_FAILOVER_ORDER'
          ? 'openai,typo'
          : key === 'OPENAI_API_KEY'
            ? 'key'
            : undefined,
      ),
    ).toThrow(/unsupported|unknown|typo/i);
  });
});
