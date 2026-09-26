import {
  createLlmProviderAdapter,
  createFailoverLlmProviderAdapter,
  OpenAiAdapter,
  FailoverLlmProviderAdapter,
} from '@wispace/llm-agent/adapters';
import type {
  LlmProviderEntryConfig,
  LlmProviderPolicy,
} from '@wispace/llm-agent/adapters';
import { PlatformAgentService } from '@wispace/chat-agent';
import {
  RescheduleRecoveryCronService,
  TypeormRescheduleStore,
} from '@wispace/reschedule-confirm/adapters';
import { DiscordSharedModule } from './discord-shared.module';
import { DiscordChatModule } from './discord-chat.module';

const TEST_POLICY: LlmProviderPolicy = {
  nodeEnv: 'test',
  allowedBaseUrlHosts: ['api.openai.com', 'llm.example.test'],
  allowedModels: ['openai:gpt-5.4', 'openai-compatible:openai/gpt-4o-mini'],
};

function findFactoryProvider(module: object, token: unknown) {
  const providers = (Reflect.getMetadata('providers', module) ??
    []) as Array<unknown>;
  return providers.find(
    (
      provider,
    ): provider is {
      provide: unknown;
      useFactory: (...args: unknown[]) => unknown;
    } =>
      typeof provider === 'object' &&
      provider !== null &&
      'provide' in provider &&
      provider.provide === token &&
      'useFactory' in provider &&
      typeof provider.useFactory === 'function',
  );
}

describe('Discord chat module — LLM provider factory', () => {
  it('wires reschedule persistence from the owning adapter entrypoint', () => {
    const storeBinding = findFactoryProvider(
      DiscordChatModule,
      TypeormRescheduleStore,
    );
    const recoveryBinding = findFactoryProvider(
      DiscordChatModule,
      RescheduleRecoveryCronService,
    );

    expect(storeBinding).toBeDefined();
    expect(recoveryBinding).toBeDefined();

    const store = storeBinding!.useFactory({});
    const recovery = recoveryBinding!.useFactory(
      store,
      { registerCron: jest.fn() },
      {},
    );

    expect(store).toBeInstanceOf(TypeormRescheduleStore);
    expect((store as { platform: string }).platform).toBe('discord');
    expect(recovery).toBeInstanceOf(RescheduleRecoveryCronService);
  });

  it('registers one shared coordinator with feature-local execution ports', () => {
    const providers = (Reflect.getMetadata('providers', DiscordSharedModule) ??
      []) as Array<{ provide?: unknown }>;
    expect(providers.map((provider) => provider.provide)).toEqual(
      expect.arrayContaining([
        'LLM_ADMISSION_COORDINATOR',
        'LLM_EXECUTION_PORT',
        'LLM_REPORT_EXECUTION_PORT',
      ]),
    );
  });

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

  it('wires PlatformAgentService with LlmContentClassifier in DiscordChatModule (#864, #868)', () => {
    const providers = (Reflect.getMetadata('providers', DiscordChatModule) ??
      []) as Array<unknown>;
    const binding = providers.find(
      (
        provider,
      ): provider is {
        provide: unknown;
        useFactory: (...args: unknown[]) => unknown;
      } =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === PlatformAgentService &&
        'useFactory' in provider &&
        typeof provider.useFactory === 'function',
    );
    expect(binding).toBeDefined();

    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'LLM_INPUT_CLASSIFIER_ENABLED') return 'true';
        if (key === 'LLM_INPUT_CLASSIFIER_MODEL')
          return 'google/gemini-2.0-flash-lite';
        if (key === 'LLM_ALLOWED_MODELS')
          return 'openai:google/gemini-2.0-flash-lite';
        return undefined;
      }),
    };
    const adapter = {
      providerName: 'openrouter',
      getDefaultModel: () => 'google/gemini-2.0-flash-lite',
      isRateLimitError: () => false,
    };
    const metrics = {
      incClassifierInput: jest.fn(),
      incClassifierVerdict: jest.fn(),
    };

    const agent = binding!.useFactory(
      configService,
      {},
      {},
      {},
      {},
      adapter,
      {},
      metrics,
      null,
      {},
      {},
      {},
      {},
    );
    expect(agent).toBeInstanceOf(PlatformAgentService);
  });

  it('fails closed at startup when LLM_INPUT_CLASSIFIER_ENABLED=true with unapproved model (#864, #868)', () => {
    const providers = (Reflect.getMetadata('providers', DiscordChatModule) ??
      []) as Array<unknown>;
    const binding = providers.find(
      (
        provider,
      ): provider is {
        provide: unknown;
        useFactory: (...args: unknown[]) => unknown;
      } =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === PlatformAgentService &&
        'useFactory' in provider &&
        typeof provider.useFactory === 'function',
    );
    expect(binding).toBeDefined();

    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'LLM_INPUT_CLASSIFIER_ENABLED') return 'true';
        if (key === 'LLM_INPUT_CLASSIFIER_MODEL') return 'unapproved-model';
        if (key === 'LLM_ALLOWED_MODELS')
          return 'openai:google/gemini-2.0-flash-lite';
        return undefined;
      }),
    };

    expect(() =>
      binding!.useFactory(
        configService,
        {},
        {},
        {},
        {},
        { providerName: 'openai', isRateLimitError: () => false },
        {},
        {},
        null,
        {},
        {},
        {},
        {},
      ),
    ).toThrow(/not approved by LLM_ALLOWED_MODELS/i);
  });
});
