import { createLlmProviderAdapterFromEnv } from './from-env.factory';
import { FailoverLlmProviderAdapter } from './failover/failover-adapter';
import type { LlmProviderPolicy } from './provider-policy';

const POLICY_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LLM_ALLOWED_BASE_URLS:
    'api.openai.com,openrouter.ai,api.minimax.chat,llm.example.test',
  LLM_ALLOWED_MODELS:
    'openai:gpt-5.4,openrouter:openai/gpt-4o-mini,minimax:MiniMax-Text-01,openai-compatible:gpt-5.4',
};

function env(
  values: Record<string, string> = {},
): (key: string) => string | undefined {
  const all = { ...POLICY_ENV, ...values };
  return (key) => all[key];
}

describe('createLlmProviderAdapterFromEnv', () => {
  it('returns openai adapter when no failover order env is set', () => {
    const adapter = createLlmProviderAdapterFromEnv(
      env({ OPENAI_API_KEY: 'key', OPENAI_MODEL: 'gpt-5.4' }),
    );
    expect(adapter).toBeInstanceOf(FailoverLlmProviderAdapter);
  });

  it('returns failover adapter when order env is set with multiple providers', () => {
    const adapter = createLlmProviderAdapterFromEnv(
      env({
        LLM_PROVIDER_FAILOVER_ORDER: 'openai, openrouter',
        OPENAI_API_KEY: 'key',
        OPENAI_MODEL: 'gpt-5.4',
        OPENROUTER_API_KEY: 'key',
        OPENROUTER_MODEL: 'openai/gpt-4o-mini',
      }),
    );
    expect(adapter).toBeInstanceOf(FailoverLlmProviderAdapter);
  });

  it('uses defaultProviderOrder when order env is empty', () => {
    const adapter = createLlmProviderAdapterFromEnv(
      env({ OPENAI_API_KEY: 'key', OPENAI_MODEL: 'gpt-5.4' }),
      { defaultProviderOrder: ['openai'] },
    );
    expect(adapter).toBeInstanceOf(FailoverLlmProviderAdapter);
  });

  it('passes the configured retry budget to the adapter', () => {
    const adapter = createLlmProviderAdapterFromEnv(
      env({
        OPENAI_API_KEY: 'key',
        OPENAI_MODEL: 'gpt-5.4',
        LLM_OPENAI_RETRY_MAX_ATTEMPTS: '4',
      }),
    );

    expect((adapter as unknown as { maxAttempts: number }).maxAttempts).toBe(4);
  });

  it('fails startup when an explicitly ordered provider has no key', () => {
    expect(() =>
      createLlmProviderAdapterFromEnv(
        env({
          LLM_PROVIDER_FAILOVER_ORDER: 'openai,openrouter',
          OPENAI_API_KEY: 'key',
          OPENAI_MODEL: 'gpt-5.4',
        }),
      ),
    ).toThrow(/openrouter.*missing API key/i);
  });

  it('fails startup for an unknown provider name', () => {
    expect(() =>
      createLlmProviderAdapterFromEnv(
        env({
          LLM_PROVIDER_FAILOVER_ORDER: 'openai,typo',
          OPENAI_API_KEY: 'key',
          OPENAI_MODEL: 'gpt-5.4',
        }),
      ),
    ).toThrow(/unsupported|unknown|typo/i);
  });

  it('requires an explicit model instead of applying a provider default', () => {
    expect(() =>
      createLlmProviderAdapterFromEnv(env({ OPENAI_API_KEY: 'key' })),
    ).toThrow(/openai.*model.*explicitly configured|empty/i);
  });

  it('rejects a missing endpoint allowlist for an active provider', () => {
    expect(() =>
      createLlmProviderAdapterFromEnv(
        env({
          OPENAI_API_KEY: 'key',
          OPENAI_MODEL: 'gpt-5.4',
          LLM_ALLOWED_BASE_URLS: '',
        }),
      ),
    ).toThrow(/LLM_ALLOWED_BASE_URLS.*non-empty/i);
  });

  it('keeps disabled execution on the unconfigured fallback without new allowlists', () => {
    const adapter = createLlmProviderAdapterFromEnv(
      env({ LLM_EXECUTION_ENABLED: 'false', OPENAI_API_KEY: 'key' }),
    );
    expect(adapter.isConfigured()).toBe(false);
    expect(adapter.getDefaultModel()).toBe('gpt-5.4');
  });

  it('accepts an injected policy independently of environment parsing', () => {
    const policy: LlmProviderPolicy = {
      nodeEnv: 'test',
      allowedBaseUrlHosts: ['api.openai.com'],
      allowedModels: ['openai:explicit-model'],
    };
    const adapter = createLlmProviderAdapterFromEnv(
      (key) => ({ OPENAI_API_KEY: 'key', OPENAI_MODEL: 'explicit-model' })[key],
      policy,
    );
    expect(adapter).toBeInstanceOf(FailoverLlmProviderAdapter);
  });
});
