import { createLlmProviderAdapterFromEnv } from './from-env.factory';
import { OpenAiAdapter } from './openai/openai-adapter';
import { FailoverLlmProviderAdapter } from './failover/failover-adapter';

describe('createLlmProviderAdapterFromEnv', () => {
  it('returns openai adapter when no failover order env is set', () => {
    const adapter = createLlmProviderAdapterFromEnv((key) =>
      key === 'OPENAI_API_KEY' ? 'key' : undefined,
    );
    expect(adapter).toBeInstanceOf(OpenAiAdapter);
    expect(adapter).not.toBeInstanceOf(FailoverLlmProviderAdapter);
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
    expect(adapter).toBeInstanceOf(OpenAiAdapter);
  });
});
