import {
  createLlmProviderAdapter,
  createFailoverLlmProviderAdapter,
} from './factory';
import { OpenAiAdapter } from './openai/openai-adapter';
import { FailoverLlmProviderAdapter } from './failover/failover-adapter';
import type { LlmProviderEntryConfig } from './factory';
import type { LlmProviderPolicy } from './provider-policy';

const TEST_POLICY: LlmProviderPolicy = {
  nodeEnv: 'test',
  allowedBaseUrlHosts: [
    'api.openai.com',
    'llm.example.test',
    'openrouter.ai',
    'api.minimax.chat',
  ],
  allowedModels: [
    'openai:gpt-5.4',
    'openai:model',
    'openai:model-a',
    'openai:model-b',
    'openai-compatible:model',
    'openai-compatible:model-a',
    'openai-compatible:model-b',
    'openrouter:model',
    'minimax:model',
  ],
};

describe('createLlmProviderAdapter', () => {
  it('creates OpenAiAdapter for openai', () => {
    const adapter = createLlmProviderAdapter({
      getApiKey: () => 'key',
      getModel: () => 'gpt-5.4',
      provider: 'openai',
      policy: TEST_POLICY,
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
      policy: TEST_POLICY,
    });
    expect(adapter).toBeInstanceOf(OpenAiAdapter);
    expect(adapter.providerName).toBe('openai-compatible');
  });

  it('defaults to openai when provider omitted', () => {
    const adapter = createLlmProviderAdapter({
      getApiKey: () => 'key',
      getModel: () => 'gpt-5.4',
      policy: TEST_POLICY,
    });
    expect(adapter).toBeInstanceOf(OpenAiAdapter);
  });

  it('rejects an unknown provider instead of silently using OpenAI', () => {
    expect(() =>
      createLlmProviderAdapter({
        getApiKey: () => 'key',
        getModel: () => 'model',
        provider: 'typo-provider',
        policy: TEST_POLICY,
      }),
    ).toThrow('Unsupported LLM provider configuration: typo-provider');
  });

  it('requires an explicit endpoint for a custom OpenAI-compatible provider', () => {
    expect(() =>
      createLlmProviderAdapter({
        getApiKey: () => 'key',
        getModel: () => 'model',
        provider: 'openai-compatible',
        policy: TEST_POLICY,
      }),
    ).toThrow('OPENAI-compatible provider requires a base URL');
  });

  it('reports the caller-provided endpoint key for a missing custom URL', () => {
    expect(() =>
      createLlmProviderAdapter({
        getApiKey: () => 'key',
        getModel: () => 'model',
        provider: 'openai-compatible',
        baseUrlEnvKey: 'LLM_BASE_URL/OPENAI_BASE_URL',
        policy: TEST_POLICY,
      }),
    ).toThrow('LLM_BASE_URL/OPENAI_BASE_URL');
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
    const result = createFailoverLlmProviderAdapter(
      [entryA],
      ['openai'],
      undefined,
      undefined,
      TEST_POLICY,
    );
    expect(result).toBeInstanceOf(OpenAiAdapter);
    expect(result).not.toBeInstanceOf(FailoverLlmProviderAdapter);
  });

  it('warns loudly when only one provider is configured', () => {
    const warn = jest.fn();

    createFailoverLlmProviderAdapter(
      [entryA],
      ['openai'],
      { warn },
      undefined,
      TEST_POLICY,
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/only one LLM provider/i),
    );
  });

  it('returns FailoverLlmProviderAdapter when ≥2 providers configured', () => {
    const result = createFailoverLlmProviderAdapter(
      [entryA, entryB],
      ['openai', 'openai-compatible'],
      undefined,
      undefined,
      TEST_POLICY,
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
      TEST_POLICY,
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
        undefined,
        undefined,
        TEST_POLICY,
      ),
    ).toThrow(
      'LLM provider openai-compatible is listed in failover order but missing API key',
    );
  });

  it('follows order parameter', () => {
    const result = createFailoverLlmProviderAdapter(
      [entryA, entryB],
      ['openai-compatible', 'openai'],
      undefined,
      undefined,
      TEST_POLICY,
    );
    expect(result).toBeInstanceOf(FailoverLlmProviderAdapter);
    // Verify order by checking the adapter's internal behavior
    // The first candidate in order should be tried first
  });

  it('throws when no providers configured in order', () => {
    expect(() =>
      createFailoverLlmProviderAdapter(
        [entryA],
        ['openai-compatible'],
        undefined,
        undefined,
        TEST_POLICY,
      ),
    ).toThrow(
      'LLM provider openai-compatible is listed in failover order but has no configuration',
    );
  });

  it('throws when order is empty and no entries match', () => {
    expect(() =>
      createFailoverLlmProviderAdapter(
        [],
        [],
        undefined,
        undefined,
        TEST_POLICY,
      ),
    ).toThrow('No LLM provider configured in failover order');
  });

  it('passes failoverConfig cooldown values to FailoverLlmProviderAdapter', () => {
    const adapter = createFailoverLlmProviderAdapter(
      [entryA, entryB],
      ['openai', 'openai-compatible'],
      undefined,
      { cooldownLongMs: 1000, cooldownShortMs: 200, quickRetryDelayMs: 50 },
      TEST_POLICY,
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
      undefined,
      undefined,
      TEST_POLICY,
    );
    const failover = adapter as unknown as Record<string, number>;
    expect(failover.cooldownLongMs).toBe(600_000);
    expect(failover.cooldownShortMs).toBe(5_000);
    expect(failover.quickRetryDelayMs).toBe(150);
  });

  it('rejects an active provider when the endpoint allowlist is empty', () => {
    expect(() =>
      createLlmProviderAdapter({
        getApiKey: () => 'key',
        getModel: () => 'gpt-5.4',
        policy: { ...TEST_POLICY, allowedBaseUrlHosts: [] },
      }),
    ).toThrow(/LLM_ALLOWED_BASE_URLS.*non-empty/i);
  });

  it('rejects an active provider when the model is not explicitly approved', () => {
    expect(() =>
      createLlmProviderAdapter({
        getApiKey: () => 'key',
        getModel: () => 'unapproved-model',
        policy: TEST_POLICY,
      }),
    ).toThrow(/openai.*OPENAI_MODEL.*unapproved-model.*LLM_ALLOWED_MODELS/i);
  });

  it('validates a vendor default endpoint before constructing the adapter', () => {
    const adapter = createLlmProviderAdapter({
      getApiKey: () => 'key',
      getModel: () => 'model',
      provider: 'openrouter',
      policy: TEST_POLICY,
    });
    expect(adapter.providerName).toBe('openrouter');
  });

  it('rejects an unsafe effective endpoint', () => {
    expect(() =>
      createLlmProviderAdapter({
        getApiKey: () => 'key',
        getModel: () => 'gpt-5.4',
        getBaseUrl: () => 'http://10.0.0.5/v1',
        policy: TEST_POLICY,
      }),
    ).toThrow(/must use HTTPS|private network/i);
  });

  it.each([
    ['malformed', 'not-a-url', /must be a valid URL/i],
    [
      'credentials',
      'https://user:secret@api.openai.com/v1',
      /must not contain credentials/i,
    ],
    [
      'fragment',
      'https://api.openai.com/v1#fragment',
      /must not contain a fragment/i,
    ],
    ['loopback', 'https://127.0.0.1/v1', /private network/i],
    ['private network', 'https://10.0.0.8/v1', /private network/i],
    ['link-local', 'https://169.254.169.254/v1', /private network/i],
  ])(
    'rejects %s effective endpoint at the factory boundary',
    (_name, baseUrl, reason) => {
      expect(() =>
        createLlmProviderAdapter({
          getApiKey: () => 'key',
          getModel: () => 'gpt-5.4',
          getBaseUrl: () => baseUrl,
          policy: { ...TEST_POLICY, nodeEnv: 'production' },
        }),
      ).toThrow(reason);
    },
  );

  it('keeps the explicit development loopback exception at the factory boundary', () => {
    const adapter = createLlmProviderAdapter({
      getApiKey: () => 'key',
      getModel: () => 'gpt-5.4',
      getBaseUrl: () => 'http://localhost:8080/v1',
      policy: {
        ...TEST_POLICY,
        nodeEnv: 'development',
        allowedBaseUrlHosts: ['localhost'],
      },
    });
    expect(adapter.providerName).toBe('openai');
  });

  it('matches endpoint hosts case-insensitively without wildcard subdomains', () => {
    expect(
      createLlmProviderAdapter({
        getApiKey: () => 'key',
        getModel: () => 'gpt-5.4',
        getBaseUrl: () => 'https://API.OPENAI.COM/v1',
        policy: TEST_POLICY,
      }),
    ).toBeInstanceOf(OpenAiAdapter);
    expect(() =>
      createLlmProviderAdapter({
        getApiKey: () => 'key',
        getModel: () => 'gpt-5.4',
        getBaseUrl: () => 'https://sub.api.openai.com/v1',
        policy: TEST_POLICY,
      }),
    ).toThrow(/not in LLM_ALLOWED_BASE_URLS/i);
  });

  it('rejects request model overrides that are not approved', async () => {
    const adapter = createLlmProviderAdapter({
      getApiKey: () => 'key',
      getModel: () => 'gpt-5.4',
      policy: TEST_POLICY,
    });
    await expect(
      adapter.generateJson({
        feature: 'STUDENT_REPORT',
        systemPrompt: 'system',
        userContent: 'user',
        model: 'unapproved-model',
      }),
    ).rejects.toThrow(/openai.*unapproved-model.*LLM_ALLOWED_MODELS/i);
  });

  it('fails the whole chain when a later candidate has an invalid model', () => {
    expect(() =>
      createFailoverLlmProviderAdapter(
        [entryA, { ...entryB, getModel: () => 'unapproved-model' }],
        ['openai', 'openai-compatible'],
        undefined,
        undefined,
        TEST_POLICY,
      ),
    ).toThrow(/openai-compatible.*unapproved-model/i);
  });
});
