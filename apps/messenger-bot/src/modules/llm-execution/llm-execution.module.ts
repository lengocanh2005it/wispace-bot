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
  acquireRedisSlot,
} from '@wispace/llm-agent/adapters';
import type { LlmProviderAdapter } from '@wispace/llm-agent/adapters';
import { BotMetricsService } from '@wispace/bot-metrics';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import type Redis from 'ioredis';
import {
  LLM_GLOBAL_CONCURRENCY_PORT,
  type LlmGlobalConcurrencyPort,
} from './application/ports/llm-global-concurrency.port';

/**
 * Provides LLM execution infrastructure: concurrency control, retry, timeout,
 * and the provider-agnostic LLM adapter.
 */
@Module({
  providers: [
    LlmExecutionConfigService,
    LlmExecutionService,
    {
      provide: LLM_GLOBAL_CONCURRENCY_PORT,
      useFactory: (
        config: LlmExecutionConfigService,
        redisClient?: RedisClientPort | null,
      ): LlmGlobalConcurrencyPort | null => {
        if (!config.isGlobalConcurrencyEnabled()) return null;
        const redis = redisClient?.getNativeClient();
        if (!redis) return null;
        return {
          acquire: (limit, logger, options) =>
            acquireRedisSlot(
              redis as Redis,
              'llm:concurrency:global',
              limit,
              logger,
              options,
            ),
        };
      },
      inject: [
        LlmExecutionConfigService,
        { token: REDIS_CLIENT, optional: true },
      ],
    },
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
          // Keep the existing fallback path while ensuring disabled execution
          // cannot leave a live provider adapter behind. The execution service
          // remains a passthrough in this mode; this is not a hard stop.
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
            error: (msg) => console.error(msg),
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
            onProviderOutcome: (provider, outcome) =>
              metrics.incLlmProviderOutcome(provider, outcome),
            onProviderNeverSucceeded: (provider) =>
              metrics.incLlmProviderNeverSucceeded(provider),
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
