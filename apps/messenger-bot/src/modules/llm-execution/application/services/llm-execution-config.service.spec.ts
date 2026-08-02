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
});
