import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmExecutionConfigService } from './application/services/llm-execution-config.service';
import { LlmExecutionService } from './application/services/llm-execution.service';
import {
  createLlmProviderAdapter,
  createFailoverLlmProviderAdapter,
  createFailoverProviderEntries,
} from '@wispace/llm-agent';
import type { LlmProviderAdapter } from '@wispace/llm-agent';

/**
 * Provides LLM execution infrastructure: concurrency control, retry, timeout,
 * and the provider-agnostic LLM adapter.
 */
@Module({
  providers: [
    LlmExecutionConfigService,
    LlmExecutionService,
    {
      provide: 'LLM_PROVIDER_ADAPTER',
      useFactory: (
        config: LlmExecutionConfigService,
        configService: ConfigService,
      ): LlmProviderAdapter => {
        const order = config.getFailoverOrder();

        if (order.length === 0) {
          return createLlmProviderAdapter({
            getApiKey: () => config.getApiKey(),
            getModel: () => config.getModel(),
            getBaseUrl: () => config.getBaseUrl(),
            provider: config.getProvider(),
          });
        }

        const get = (key: string): string | undefined => {
          if (key === 'OPENAI_API_KEY') return config.getApiKey();
          if (key === 'OPENAI_MODEL') return config.getModel();
          if (key === 'OPENAI_BASE_URL') return config.getBaseUrl();
          return configService.get<string>(key)?.trim();
        };

        const entries = createFailoverProviderEntries(get, order);

        return createFailoverLlmProviderAdapter(
          entries,
          order,
          {
            warn: (msg) => console.warn(msg),
          },
          {
            cooldownLongMs: config.getFailoverCooldownLongMs(),
            cooldownShortMs: config.getFailoverCooldownShortMs(),
            quickRetryDelayMs: config.getFailoverQuickRetryDelayMs(),
          },
        );
      },
      inject: [LlmExecutionConfigService, ConfigService],
    },
  ],
  exports: [
    LlmExecutionService,
    LlmExecutionConfigService,
    'LLM_PROVIDER_ADAPTER',
  ],
})
export class LlmExecutionModule {}
