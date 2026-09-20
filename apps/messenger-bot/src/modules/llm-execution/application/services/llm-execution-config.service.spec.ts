import { ConfigService } from '@nestjs/config';
import { LlmExecutionConfigService } from './llm-execution-config.service';

function makeConfigService(
  env: Record<string, string | undefined>,
): ConfigService {
  return {
    get: <T = string>(key: string): T | undefined => {
      return env[key] as T | undefined;
    },
  } as unknown as ConfigService;
}

describe('LlmExecutionConfigService', () => {
  describe('compatibility aliases', () => {
    it('does not apply an implicit model fallback', () => {
      const svc = new LlmExecutionConfigService(makeConfigService({}));
      expect(svc.getModel()).toBeUndefined();
    });

    it('accepts matching generic and canonical values', () => {
      const svc = new LlmExecutionConfigService(
        makeConfigService({
          LLM_MODEL: 'gpt-5.4',
          OPENAI_MODEL: 'gpt-5.4',
        }),
      );
      expect(() => svc.assertAliasConsistency()).not.toThrow();
      expect(svc.getModel()).toBe('gpt-5.4');
    });

    it('rejects conflicting generic and canonical values', () => {
      const svc = new LlmExecutionConfigService(
        makeConfigService({
          LLM_BASE_URL: 'https://one.example.com/v1',
          OPENAI_BASE_URL: 'https://two.example.com/v1',
        }),
      );
      expect(() => svc.assertAliasConsistency()).toThrow(
        /LLM_BASE_URL and OPENAI_BASE_URL must agree/i,
      );
    });
  });

  describe('getFailoverOrder', () => {
    it('returns empty array when unset', () => {
      const svc = new LlmExecutionConfigService(makeConfigService({}));
      expect(svc.getFailoverOrder()).toEqual([]);
    });

    it('parses CSV correctly', () => {
      const svc = new LlmExecutionConfigService(
        makeConfigService({
          LLM_PROVIDER_FAILOVER_ORDER: 'openai,openrouter,minimax',
        }),
      );
      expect(svc.getFailoverOrder()).toEqual([
        'openai',
        'openrouter',
        'minimax',
      ]);
    });

    it('trims whitespace', () => {
      const svc = new LlmExecutionConfigService(
        makeConfigService({
          LLM_PROVIDER_FAILOVER_ORDER: ' openai , openrouter ',
        }),
      );
      expect(svc.getFailoverOrder()).toEqual(['openai', 'openrouter']);
    });

    it('filters empty entries', () => {
      const svc = new LlmExecutionConfigService(
        makeConfigService({
          LLM_PROVIDER_FAILOVER_ORDER: 'openai,,openrouter,',
        }),
      );
      expect(svc.getFailoverOrder()).toEqual(['openai', 'openrouter']);
    });
  });

  describe('getFailoverCooldownLongMs', () => {
    it('returns 600000 by default', () => {
      const svc = new LlmExecutionConfigService(makeConfigService({}));
      expect(svc.getFailoverCooldownLongMs()).toBe(600_000);
    });

    it('returns configured value', () => {
      const svc = new LlmExecutionConfigService(
        makeConfigService({ LLM_FAILOVER_COOLDOWN_LONG_MS: '300000' }),
      );
      expect(svc.getFailoverCooldownLongMs()).toBe(300_000);
    });

    it('returns default for invalid value', () => {
      const svc = new LlmExecutionConfigService(
        makeConfigService({ LLM_FAILOVER_COOLDOWN_LONG_MS: 'abc' }),
      );
      expect(svc.getFailoverCooldownLongMs()).toBe(600_000);
    });
  });

  describe('getFailoverCooldownShortMs', () => {
    it('returns 5000 by default', () => {
      const svc = new LlmExecutionConfigService(makeConfigService({}));
      expect(svc.getFailoverCooldownShortMs()).toBe(5_000);
    });
  });

  describe('getFailoverQuickRetryDelayMs', () => {
    it('returns 150 by default', () => {
      const svc = new LlmExecutionConfigService(makeConfigService({}));
      expect(svc.getFailoverQuickRetryDelayMs()).toBe(150);
    });
  });

  describe('getMaxTotalProviderAttempts', () => {
    it('defaults to six attempts', () => {
      const svc = new LlmExecutionConfigService(makeConfigService({}));
      expect(svc.getMaxTotalProviderAttempts()).toBe(6);
    });

    it('rejects values outside the fail-closed range', () => {
      expect(
        () =>
          new LlmExecutionConfigService(
            makeConfigService({ LLM_MAX_TOTAL_PROVIDER_ATTEMPTS: '9' }),
          ),
      ).toThrow(/LLM_MAX_TOTAL_PROVIDER_ATTEMPTS/);
    });
  });
});
