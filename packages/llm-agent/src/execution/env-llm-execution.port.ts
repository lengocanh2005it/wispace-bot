import { errorMessage } from '@wispace/bot-common';
import type Redis from 'ioredis';
import type { LlmProviderAdapter } from '../provider/llm-provider.adapter';
import type { LlmExecutionPort } from '../ports';
import { retryWithBackoff } from '../utils/retry.utils';
import { acquireRedisSlot, type SlotLogger } from './redis-slot-limiter';

const FEATURE = 'FREE_FORM_CHAT';

export interface EnvLlmExecutionConfig {
  /** `LLM_EXECUTION_ENABLED` — false bypasses limiter/retry/deadline. */
  enabled: boolean;
  /** `LLM_MAX_CONCURRENT` — per-instance provider concurrency cap. */
  maxConcurrent: number;
  /** `LLM_GLOBAL_MAX_CONCURRENT` — Redis-distributed aggregate budget. */
  globalMaxConcurrent: number;
  /** `LLM_OPENAI_RETRY_MAX_ATTEMPTS` — retry budget. */
  maxAttempts: number;
  /** `LLM_OPENAI_RETRY_BACKOFF_MS` — base backoff between attempts. */
  baseBackoffMs: number;
  /** `LLM_REQUEST_TIMEOUT_MS` — per-request deadline. */
  requestTimeoutMs: number;
  /** `LLM_GLOBAL_CONCURRENCY_ENABLED` — enables the Redis aggregate budget. */
  globalConcurrencyEnabled: boolean;
  /** Optional native Redis client for the distributed budget. */
  redis?: Redis | null;
}

/** Shared Redis keyspace with the Messenger `RedisConcurrencyLimiter`. */
const REDIS_SLOT_KEY = 'llm:concurrency:global';

/**
 * Default `LlmExecutionPort` for apps without their own execution service
 * (Discord/Zalo chat + reports). Reads the same `LLM_EXECUTION_*` contract as
 * the Messenger app's `LlmExecutionConfigService` — one documented
 * execution-control path for every LLM feature:
 *  - enable flag (off = passthrough)
 *  - per-instance p-limit on provider calls
 *  - per-request deadline composed with the caller signal, aborts the
 *    in-flight provider request (issue #121)
 *  - retry budget (429/5xx) with abort-aware backoff
 *  - optional Redis-distributed aggregate budget shared across pods/bots
 */
export function createEnvLlmExecutionPort(
  config: EnvLlmExecutionConfig,
  adapter: LlmProviderAdapter,
  logger: SlotLogger,
): LlmExecutionPort {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pLimit = require('p-limit') as (
    concurrency: number,
  ) => <T>(fn: () => Promise<T>) => Promise<T>;
  const limiter = pLimit(config.maxConcurrent);
  const nativeRedis =
    config.globalConcurrencyEnabled && config.redis ? config.redis : null;

  return {
    run: async <T>(
      fn: (signal?: AbortSignal) => Promise<T>,
      meta: { feature: string; correlationId?: string; signal?: AbortSignal },
    ): Promise<T> => {
      if (!config.enabled) {
        return fn(undefined);
      }

      let release: (() => Promise<void>) | undefined;
      if (nativeRedis) {
        release = await acquireRedisSlot(
          nativeRedis,
          REDIS_SLOT_KEY,
          config.globalMaxConcurrent,
          logger,
        );
      }
      try {
        return await limiter(() => {
          const deadlineSignal = AbortSignal.timeout(config.requestTimeoutMs);
          const signal = meta?.signal
            ? AbortSignal.any([meta.signal, deadlineSignal])
            : deadlineSignal;
          return retryWithBackoff(() => fn(signal), {
            maxAttempts: config.maxAttempts,
            baseDelayMs: config.baseBackoffMs,
            isRetryable: (error) => adapter.isRetryableError(error),
            onRetry: (attempt, backoffMs, error) =>
              logger.warn(
                `LLM provider retry feature=${
                  meta?.feature ?? FEATURE
                } correlation=${
                  meta?.correlationId ?? 'n/a'
                } attempt=${attempt}/${config.maxAttempts} backoffMs=${backoffMs}: ${errorMessage(
                  error,
                )}`,
              ),
            signal,
          });
        });
      } finally {
        await release?.();
      }
    },
  };
}
