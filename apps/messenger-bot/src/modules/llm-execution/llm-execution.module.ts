import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmExecutionConfigService } from './application/services/llm-execution-config.service';
import { LlmExecutionService } from './application/services/llm-execution.service';
import {
  buildLlmProviderPolicyFromEnv,
  createFailoverLlmProviderAdapter,
  createFailoverProviderEntries,
  assertSupportedLlmProvider,
  OpenAiAdapter,
} from '@wispace/llm-agent/adapters';
import type { LlmProviderAdapter } from '@wispace/llm-agent/adapters';
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
        config.assertAliasConsistency();
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
                apiKeyEnvKey: 'LLM_API_KEY/OPENAI_API_KEY',
                getModel: () => config.getModel(),
                getBaseUrl: () => config.getBaseUrl(),
                modelEnvKey: 'LLM_MODEL/OPENAI_MODEL',
                baseUrlEnvKey: 'LLM_BASE_URL/OPENAI_BASE_URL',
              },
            ];

        if (!config.isEnabled()) {
          if (!order.length) assertSupportedLlmProvider(configuredProvider);
          // Keep the existing fallback path while ensuring the execution
          // kill-switch cannot leave a live provider adapter behind.
          return new OpenAiAdapter(() => undefined);
        }

        const policy = buildLlmProviderPolicyFromEnv((key) =>
          configService.get<string>(key)?.trim(),
        );

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
          policy,
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
