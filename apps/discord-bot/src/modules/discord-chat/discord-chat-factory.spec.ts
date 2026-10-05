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
import {
  LlmContentClassifier,
  PlatformAgentService,
} from '@wispace/chat-agent';
import {
  RescheduleRecoveryCronService,
  TypeormRescheduleStore,
} from '@wispace/reschedule-confirm/adapters';
import { RescheduleConfirmationService } from '@wispace/reschedule-confirm/core';
import { DiscordSharedModule } from './discord-shared.module';
import { DiscordChatModule } from './discord-chat.module';
import type { FactoryProvider } from '@wispace/bot-common/testing';
import {
  findEffectiveFactoryProvider,
  findFactoryProvider,
} from '@wispace/bot-common/testing';

const TEST_POLICY: LlmProviderPolicy = {
  nodeEnv: 'test',
  allowedBaseUrlHosts: ['api.openai.com', 'llm.example.test'],
  allowedModels: ['openai:gpt-5.4', 'openai-compatible:openai/gpt-4o-mini'],
};

/**
 * The classifier is built by this app's own dynamic-options provider and reaches
 * the agent through createPlatformChatProviders, so both halves of that hand-off
 * are asserted below.
 */
const DISCORD_AGENT_OPTIONS = 'DISCORD_AGENT_OPTIONS';

/**
 * The spec for #1127 forbids a hand-rolled `.find()` over the provider metadata:
 * a first-match lookup keeps reporting green after the binding it read is
 * deleted, which is the failure mode #1507 already documented. `factoryFor`
 * delegates to the shared helper, which reads the *last* binding — the one Nest
 * resolves — and adds its arity check against the provider's own `inject`.
 */
const factoryFor = (token: unknown): FactoryProvider => {
  const binding = findEffectiveFactoryProvider(DiscordChatModule, token);
  expect(binding).toBeDefined();
  return binding!;
};

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
      {},
    );

    expect(store).toBeInstanceOf(TypeormRescheduleStore);
    expect((store as { platform: string }).platform).toBe('discord');
    expect(recovery).toBeInstanceOf(RescheduleRecoveryCronService);
  });

  it('binds the recovery cron to a Discord transport so a deferred row can be replayed (#1507)', async () => {
    // The shared binding has no transport at all, and a `deferred` row then has
    // no bot that can legitimately deliver it: the messenger pod would send a
    // Discord id to Meta, be rejected, and burn all five bounded attempts.
    const binding = findEffectiveFactoryProvider(
      DiscordChatModule,
      RescheduleRecoveryCronService,
    );
    expect(binding).toBeDefined();

    const sendText = jest.fn().mockResolvedValue('sent');
    const recovery = binding!.useFactory(
      {},
      { registerCron: jest.fn() },
      {},
      {},
      { sendText },
    );

    expect(recovery).toBeInstanceOf(RescheduleRecoveryCronService);
    const notification = (
      recovery as unknown as {
        notification: { deliver: (input: unknown) => Promise<string> };
      }
    ).notification;
    await expect(
      notification.deliver({
        externalId: 'discord-user-1',
        scheduledTimeLabel: '20/09 lúc 19:00',
        userId: 42,
      }),
    ).resolves.toBe('sent');
    // userId must reach the transport or the replay charges a second budget.
    expect(sendText).toHaveBeenCalledWith(
      'discord-user-1',
      expect.stringContaining('20/09 lúc 19:00'),
      { userId: 42 },
    );
  });

  it('builds the confirmation service with the durable attempt store (#1483)', () => {
    // Without this binding no attempt record is ever created, so a repeat
    // confirmation reports "no pending request" about a committed change and
    // the recovery cron re-arms a write that already committed.
    const attemptStore = { marker: 'attempt-store' };
    const binding = findFactoryProvider(
      DiscordChatModule,
      RescheduleConfirmationService,
    );
    expect(binding).toBeDefined();

    const service = binding!.useFactory(
      {},
      { rescheduleSession: jest.fn() },
      {},
      {},
      {},
      {},
      attemptStore,
    );

    expect(
      (service as unknown as { options: { attemptStore?: unknown } }).options
        .attemptStore,
    ).toBe(attemptStore);
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
    const binding = findEffectiveFactoryProvider(
      DiscordSharedModule,
      'LLM_PROVIDER_ADAPTER',
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

    const dynamic = factoryFor(DISCORD_AGENT_OPTIONS).useFactory(
      configService,
      adapter,
      {},
      {},
      { findCurrentIdentity: jest.fn() },
      {},
      metrics,
    );
    expect(dynamic).toMatchObject({
      contentClassifier: expect.any(LlmContentClassifier),
    });

    // Nine arguments: the shared factory injects the optional REDIS_CLIENT last,
    // and the helper's arity check now fails a short call rather than letting it
    // pass a correctly-shaped service with an undefined tail.
    const agent = factoryFor(PlatformAgentService).useFactory(
      configService,
      {},
      {},
      {},
      {},
      adapter,
      {},
      dynamic,
      undefined,
    );
    expect(agent).toBeInstanceOf(PlatformAgentService);
  });

  it('fails closed at startup when LLM_INPUT_CLASSIFIER_ENABLED=true with unapproved model (#864, #868)', () => {
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
      factoryFor(DISCORD_AGENT_OPTIONS).useFactory(
        configService,
        { providerName: 'openai', isRateLimitError: () => false },
        {},
        {},
        { findCurrentIdentity: jest.fn() },
        {},
        {},
      ),
    ).toThrow(/not approved by LLM_ALLOWED_MODELS/i);
  });
});
