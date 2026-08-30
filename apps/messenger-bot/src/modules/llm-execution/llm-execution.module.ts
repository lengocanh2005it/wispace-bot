import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmExecutionConfigService } from './application/services/llm-execution-config.service';
import { LlmExecutionService } from './application/services/llm-execution.service';
import {
  createFailoverLlmProviderAdapter,
  createFailoverProviderEntries,
} from '@wispace/llm-agent';
import type { LlmProviderAdapter } from '@wispace/llm-agent';
import { BotMetricsService } from '@wispace/bot-metrics';

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
        metrics: BotMetricsService,
      ): LlmProviderAdapter => {
        const order = config.getFailoverOrder();
        const configuredProvider = (config.getProvider() ?? 'openai')
          .trim()
          .toLowerCase();
        const providerOrder = order.length ? order : [configuredProvider];

        const get = (key: string): string | undefined => {
          if (key === 'OPENAI_API_KEY') return config.getApiKey();
          if (key === 'OPENAI_MODEL') return config.getModel();
          if (key === 'OPENAI_BASE_URL') return config.getBaseUrl();
          return configService.get<string>(key)?.trim();
        };

        const entries = order.length
          ? createFailoverProviderEntries(get, providerOrder)
          : [
              {
                provider: configuredProvider,
                getApiKey: () => config.getApiKey(),
                getModel: () => config.getModel(),
                getBaseUrl: () => config.getBaseUrl(),
              },
            ];

        return createFailoverLlmProviderAdapter(
          entries,
          providerOrder,
          {
            warn: (msg) => console.warn(msg),
          },
          {
            cooldownLongMs: config.getFailoverCooldownLongMs(),
            cooldownShortMs: config.getFailoverCooldownShortMs(),
            quickRetryDelayMs: config.getFailoverQuickRetryDelayMs(),
            maxAttempts: config.getRetryMaxAttempts(),
            onCircuitEvent: (event) =>
              metrics.incLlmProviderCircuitEvent(
                event.provider,
                event.action,
                event.reason,
              ),
            onProviderAttempt: (provider, feature) =>
              metrics.incLlmProviderAttempt(provider, feature),
            onProvidersExhausted: (providers, feature) =>
              metrics.incLlmProvidersExhausted(providers.length, feature),
          },
        );
      },
      inject: [LlmExecutionConfigService, ConfigService, BotMetricsService],
    },
  ],
  exports: [
    LlmExecutionService,
    LlmExecutionConfigService,
    'LLM_PROVIDER_ADAPTER',
  ],
})
export class LlmExecutionModule {}
