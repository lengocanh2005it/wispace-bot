import { errorMessage } from '@wispace/bot-common/masking';
import { isAbortError } from '@wispace/bot-common/utils';
import type Redis from 'ioredis';
import type { LlmProviderAdapter } from '../provider/llm-provider.adapter';
import type { LlmExecutionPort } from '../ports';
import { retryWithBackoff } from '../utils/retry.utils';
import { acquireRedisSlot, type SlotLogger } from './redis-slot-limiter';
import {
  BoundedAdmissionQueue,
  LlmOverloadError,
  admissionWaitBudgetMs,
  type AdmissionTicket,
} from './bounded-admission';
import { LlmProviderCircuitOpenError } from './circuit-error';

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
  /** `LLM_MAX_QUEUE_DEPTH` — hard cap on locally queued admissions (#389). */
  maxQueueDepth: number;
  /** `LLM_ADMISSION_WAIT_MS` — wait budget for interactive chat (#389). */
  chatAdmissionWaitMs: number;
  /** `LLM_BACKGROUND_ADMISSION_WAIT_MS` — background sheds first (#389). */
  backgroundAdmissionWaitMs: number;
  /** Internal test seam: bound the Redis acquire retry loop. */
  globalAcquireMaxRetries?: number;
  /** Internal test seam: Redis acquire retry delay in ms. */
  globalAcquireRetryDelayMs?: number;
}

/** Shared Redis keyspace for the cross-pod aggregate LLM budget. */
const REDIS_SLOT_KEY = 'llm:concurrency:global';
const EXECUTION_CIRCUIT_FAILURE_THRESHOLD = 3;
const EXECUTION_CIRCUIT_RESET_MS = 60_000;

/**
 * Admission telemetry for all three bots (#389): low-cardinality rejection
 * reasons plus how long admitted calls waited before execution started.
 * Extends SlotMetrics so the same object feeds the shared Redis slot limiter.
 */
export interface AdmissionMetrics {
  incrementCounter(name: string, labels?: Record<string, string>): void;
  observeWaitSeconds(seconds: number): void;
  /** Optional local queue saturation gauge (#389). */
  observeQueueDepth?(depth: number): void;
}

/**
 * Default `LlmExecutionPort` for apps without their own execution service
 * (Discord/Zalo chat + reports). Reads the same `LLM_EXECUTION_*` contract as
 * the Messenger app's `LlmExecutionConfigService` — one documented
 * execution-control path for every LLM feature:
 *  - enable flag (off = passthrough)
 *  - per-instance bounded admission queue on provider calls (#389)
 *  - per-request deadline composed with the caller signal, aborts the
 *    in-flight provider request (issue #121)
 *  - shared execution circuit breaker for provider exhaustion
 *  - retry budget (429/5xx) with abort-aware backoff
 *  - optional Redis-distributed aggregate budget shared across pods/bots
 */
export function createEnvLlmExecutionPort(
  config: EnvLlmExecutionConfig,
  adapter: LlmProviderAdapter,
  logger: SlotLogger,
  metrics?: AdmissionMetrics,
): LlmExecutionPort {
  if (config.enabled && config.globalConcurrencyEnabled && !config.redis) {
    throw new Error(
      'LLM_GLOBAL_CONCURRENCY_ENABLED=true requires a Redis client — refusing to start with the aggregate limit silently bypassed (#389)',
    );
  }
  const queue = new BoundedAdmissionQueue(
    config.maxConcurrent,
    config.maxQueueDepth,
  );
  const nativeRedis = config.globalConcurrencyEnabled
    ? (config.redis ?? null)
    : null;
  let consecutiveFailures = 0;
  let circuitOpenedAt = 0;
  let halfOpenInFlight = false;

  const assertCircuitAvailable = (): void => {
    if (!circuitOpenedAt) return;

    if (Date.now() - circuitOpenedAt < EXECUTION_CIRCUIT_RESET_MS) {
      throw new LlmProviderCircuitOpenError('open');
    }

    if (halfOpenInFlight) {
      throw new LlmProviderCircuitOpenError('half_open');
    }
    halfOpenInFlight = true;
  };

  const recordSuccess = (): void => {
    if (circuitOpenedAt) {
      logger.warn('LLM provider execution circuit closed — recovered');
    }
    consecutiveFailures = 0;
    circuitOpenedAt = 0;
    halfOpenInFlight = false;
  };

  const recordFailure = (error: unknown): void => {
    if (isAbortError(error)) {
      halfOpenInFlight = false;
      return;
    }

    consecutiveFailures += 1;
    if (consecutiveFailures >= EXECUTION_CIRCUIT_FAILURE_THRESHOLD) {
      circuitOpenedAt = Date.now();
      halfOpenInFlight = false;
      logger.warn('LLM provider execution circuit OPEN — failing fast');
    }
  };

  return {
    run: async <T>(
      fn: (signal?: AbortSignal) => Promise<T>,
      meta: { feature: string; correlationId?: string; signal?: AbortSignal },
    ): Promise<T> => {
      if (!config.enabled) {
        return fn(undefined);
      }
      assertCircuitAvailable();

      // One deadline covers admission, the optional Redis slot, retries, and
      // the provider request; no nested layer gets a fresh timeout budget.
      const deadlineSignal = AbortSignal.timeout(config.requestTimeoutMs);
      const signal = meta?.signal
        ? AbortSignal.any([meta.signal, deadlineSignal])
        : deadlineSignal;

      // Acquire global Redis slot INSIDE the local limiter callback (#153) —
      // slots are only held during actual LLM execution, not while waiting
      // in the bounded admission queue.
      const startedAtMs = Date.now();
      let ticket: AdmissionTicket;
      try {
        ticket = await queue.acquire({
          signal,
          waitBudgetMs: admissionWaitBudgetMs(config, meta?.feature),
        });
      } catch (error) {
        // A half-open probe may be rejected before a provider call (queue or
        // Redis failure); do not leave the execution circuit wedged forever.
        halfOpenInFlight = false;
        if (error instanceof LlmOverloadError) {
          metrics?.incrementCounter('llm_admission_rejected_total', {
            reason: error.reason,
          });
          metrics?.observeQueueDepth?.(queue.waitingCount);
        }
        throw error;
      }
      metrics?.observeWaitSeconds((Date.now() - startedAtMs) / 1000);
      metrics?.observeQueueDepth?.(queue.waitingCount);

      let release: (() => Promise<void>) | undefined;
      const waitBudgetMs = admissionWaitBudgetMs(config, meta?.feature);
      try {
        if (nativeRedis) {
          // Compose deadline + caller signal BEFORE slot acquisition so
          // cancellation aborts the Redis retry loop and avoids holding
          // a local admission slot while spinning (#364).
          release = await acquireRedisSlot(
            nativeRedis,
            REDIS_SLOT_KEY,
            config.globalMaxConcurrent,
            logger,
            {
              metrics,
              signal,
              leaseMs: Math.max(config.requestTimeoutMs, 60_000),
              maxRetries: config.globalAcquireMaxRetries,
              retryDelayMs: config.globalAcquireRetryDelayMs,
              waitBudgetMs,
            },
          );
        }
        try {
          const result = await retryWithBackoff(() => fn(signal), {
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
          recordSuccess();
          return result;
        } catch (error) {
          recordFailure(error);
          throw error;
        }
      } finally {
        halfOpenInFlight = false;
        await release?.();
        ticket.release();
        metrics?.observeQueueDepth?.(queue.waitingCount);
      }
    },
  };
}
