import {
  createLlmProviderAdapter,
  createFailoverLlmProviderAdapter,
  OpenAiAdapter,
  FailoverLlmProviderAdapter,
} from '@wispace/llm-agent';
import type {
  LlmProviderEntryConfig,
  LlmProviderPolicy,
} from '@wispace/llm-agent';
import { DiscordSharedModule } from './discord-shared.module';

const TEST_POLICY: LlmProviderPolicy = {
  nodeEnv: 'test',
  allowedBaseUrlHosts: ['api.openai.com', 'llm.example.test'],
  allowedModels: ['openai:gpt-5.4', 'openai-compatible:openai/gpt-4o-mini'],
};

describe('Discord chat module — LLM provider factory', () => {
  it('wires the shared fail-closed policy into the startup binding', () => {
    const providers = (Reflect.getMetadata('providers', DiscordSharedModule) ??
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
    expect(() =>
      binding!.useFactory(
        {
          get: (key: string) =>
            ({
              NODE_ENV: 'production',
              OPENAI_API_KEY: 'sk-test',
              OPENAI_MODEL: 'gpt-5.4',
              LLM_ALLOWED_BASE_URLS: '',
              LLM_ALLOWED_MODELS: 'openai:gpt-5.4',
            })[key],
        },
        {},
      ),
    ).toThrow(/LLM_ALLOWED_BASE_URLS.*non-empty/i);
  });

  describe('when LLM_PROVIDER_FAILOVER_ORDER is empty (default)', () => {
    it('returns single OpenAiAdapter — regression: existing deployments unchanged', () => {
      const adapter = createLlmProviderAdapter({
        getApiKey: () => 'test-key',
        getModel: () => 'gpt-5.4',
        provider: 'openai',
        policy: TEST_POLICY,
      });
      expect(adapter).toBeInstanceOf(OpenAiAdapter);
      expect(adapter).not.toBeInstanceOf(FailoverLlmProviderAdapter);
    });
  });

  describe('when LLM_PROVIDER_FAILOVER_ORDER has ≥2 providers', () => {
    it('returns FailoverLlmProviderAdapter', () => {
      const entries: LlmProviderEntryConfig[] = [
        {
          provider: 'openai',
          getApiKey: () => 'sk-test-a',
          getModel: () => 'gpt-5.4',
        },
        {
          provider: 'openai-compatible',
          getApiKey: () => 'compat-test-b',
          getModel: () => 'openai/gpt-4o-mini',
          getBaseUrl: () => 'https://llm.example.test/v1',
        },
      ];
      const adapter = createFailoverLlmProviderAdapter(
        entries,
        ['openai', 'openai-compatible'],
        undefined,
        undefined,
        TEST_POLICY,
      );
      expect(adapter).toBeInstanceOf(FailoverLlmProviderAdapter);
    });
  });

  describe('when only 1 provider configured in order', () => {
    it('fails closed when the configured order names a missing provider', () => {
      const entries: LlmProviderEntryConfig[] = [
        {
          provider: 'openai',
          getApiKey: () => 'sk-test-a',
          getModel: () => 'gpt-5.4',
        },
      ];
      expect(() =>
        createFailoverLlmProviderAdapter(
          entries,
          ['openai', 'openai-compatible'],
          undefined,
          undefined,
          TEST_POLICY,
        ),
      ).toThrow(/missing provider|no configuration/i);
    });
  });
});
