import { LlmExecutionModule } from './llm-execution.module';

describe('Messenger LLM startup binding', () => {
  it('wires the shared fail-closed policy into the adapter factory', () => {
    const providers = (Reflect.getMetadata('providers', LlmExecutionModule) ??
      []) as Array<unknown>;
    const binding = providers.find(
      (
        provider,
      ): provider is {
        provide: string;
        useFactory: (...args: unknown[]) => unknown;
      } =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === 'LLM_PROVIDER_ADAPTER' &&
        'useFactory' in provider &&
        typeof provider.useFactory === 'function',
    );
    expect(binding).toBeDefined();

    const config = {
      assertAliasConsistency: () => undefined,
      isEnabled: () => true,
      getFailoverOrder: () => [],
      getProvider: () => 'openai',
      getApiKey: () => 'sk-test',
      getModel: () => 'gpt-5.4',
      getBaseUrl: () => undefined,
      getFailoverCooldownLongMs: () => 600_000,
      getFailoverCooldownShortMs: () => 5_000,
      getFailoverQuickRetryDelayMs: () => 150,
      getRetryMaxAttempts: () => 1,
    };
    const configService = {
      get: (key: string) =>
        ({
          NODE_ENV: 'production',
          LLM_ALLOWED_BASE_URLS: '',
          LLM_ALLOWED_MODELS: 'openai:gpt-5.4',
        })[key],
    };

    expect(() => binding!.useFactory(config, configService, {})).toThrow(
      /LLM_ALLOWED_BASE_URLS.*non-empty/i,
    );
  });

  it('keeps the disabled execution fallback unconfigured', () => {
    const providers = (Reflect.getMetadata('providers', LlmExecutionModule) ??
      []) as Array<unknown>;
    const binding = providers.find(
      (
        provider,
      ): provider is {
        provide: string;
        useFactory: (...args: unknown[]) => unknown;
      } =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === 'LLM_PROVIDER_ADAPTER' &&
        'useFactory' in provider &&
        typeof provider.useFactory === 'function',
    );
    expect(binding).toBeDefined();

    const config = {
      assertAliasConsistency: () => undefined,
      isEnabled: () => false,
      getFailoverOrder: () => [],
      getProvider: () => 'openai',
    };
    const adapter = binding!.useFactory(config, { get: () => undefined }, {});
    expect((adapter as { isConfigured(): boolean }).isConfigured()).toBe(false);
  });
});
