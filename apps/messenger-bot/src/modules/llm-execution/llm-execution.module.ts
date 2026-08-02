import { Module } from '@nestjs/common';
import { LlmExecutionConfigService } from './application/services/llm-execution-config.service';
import { LlmExecutionService } from './application/services/llm-execution.service';
import {
  createLlmProviderAdapter,
  createFailoverLlmProviderAdapter,
} from '@wispace/llm-agent';
import type {
  LlmProviderAdapter,
  LlmProviderEntryConfig,
} from '@wispace/llm-agent';
import { RedisConcurrencyLimiter } from './infrastructure/redis-concurrency-limiter';
import {
  REDIS_CLIENT,
  type RedisClientPort,
} from '../../infrastructure/redis/redis.client.port';

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
      useFactory: (config: LlmExecutionConfigService): LlmProviderAdapter => {
        const order = config.getFailoverOrder();

        if (order.length === 0) {
          return createLlmProviderAdapter({
            getApiKey: () => config.getApiKey(),
            getModel: () => config.getModel(),
            getBaseUrl: () => config.getBaseUrl(),
            provider: config.getProvider(),
          });
        }

        const entries: LlmProviderEntryConfig[] = [
          {
            provider: 'openai',
            getApiKey: () => config.getApiKey(),
            getModel: () => config.getModel(),
            getBaseUrl: () => config.getBaseUrl(),
          },
        ];

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
      inject: [LlmExecutionConfigService],
    },
    {
      provide: RedisConcurrencyLimiter,
      useFactory: (
        redisClient: RedisClientPort | null,
      ): RedisConcurrencyLimiter | null => {
        const enabled =
          process.env.LLM_GLOBAL_CONCURRENCY_ENABLED?.toLowerCase() === 'true';
        const redis = redisClient?.getNativeClient();
        if (!enabled || !redis) return null;
        return new RedisConcurrencyLimiter(redis);
      },
      inject: [{ token: REDIS_CLIENT, optional: true }],
    },
  ],
  exports: [
    LlmExecutionService,
    LlmExecutionConfigService,
    'LLM_PROVIDER_ADAPTER',
    RedisConcurrencyLimiter,
  ],
})
export class LlmExecutionModule {}
