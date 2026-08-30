import {
  createLlmProviderAdapter,
  createFailoverLlmProviderAdapter,
  OpenAiAdapter,
  FailoverLlmProviderAdapter,
} from '@wispace/llm-agent';
import type { LlmProviderEntryConfig } from '@wispace/llm-agent';

describe('Discord chat module — LLM provider factory', () => {
  describe('when LLM_PROVIDER_FAILOVER_ORDER is empty (default)', () => {
    it('returns single OpenAiAdapter — regression: existing deployments unchanged', () => {
      const adapter = createLlmProviderAdapter({
        getApiKey: () => 'test-key',
        getModel: () => 'gpt-5.4',
        provider: 'openai',
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
          getApiKey: () => 'key-a',
          getModel: () => 'gpt-5.4',
        },
        {
          provider: 'openai-compatible',
          getApiKey: () => 'key-b',
          getModel: () => 'openai/gpt-4o-mini',
          getBaseUrl: () => 'https://llm.example.test/v1',
        },
      ];
      const adapter = createFailoverLlmProviderAdapter(entries, [
        'openai',
        'openai-compatible',
      ]);
      expect(adapter).toBeInstanceOf(FailoverLlmProviderAdapter);
    });
  });

  describe('when only 1 provider configured in order', () => {
    it('fails closed when the configured order names a missing provider', () => {
      const entries: LlmProviderEntryConfig[] = [
        {
          provider: 'openai',
          getApiKey: () => 'key-a',
          getModel: () => 'gpt-5.4',
        },
      ];
      expect(() =>
        createFailoverLlmProviderAdapter(entries, [
          'openai',
          'openai-compatible',
        ]),
      ).toThrow(/missing provider|no configuration/i);
    });
  });
});
