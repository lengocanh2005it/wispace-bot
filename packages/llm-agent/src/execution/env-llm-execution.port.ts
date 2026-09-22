import { errorMessage } from '@wispace/bot-common/masking';
import type Redis from 'ioredis';
import type { LlmProviderAdapter } from '../provider/llm-provider.adapter';
import type {
  LlmExecutionAttempt,
  LlmExecutionMode,
  LlmExecutionRetryCause,
  LlmExecutionPort,
} from '../ports';
import {
  cappedExponentialBackoff,
  retryWithBackoff,
} from '../utils/retry.utils';
import { acquireRedisSlot, type SlotLogger } from './redis-slot-limiter';
import {
  LlmOverloadError,
  LlmExecutionDisabledError,
  INTERACTIVE_LLM_FEATURES,
} from './bounded-admission';
import {
  LlmAdmissionCoordinator,
  type LlmAdmissionGlobalPort,
  type AdmissionMetrics,
} from './llm-admission-coordinator';
export type { AdmissionMetrics } from './llm-admission-coordinator';
import { LlmProviderCircuitOpenError } from './circuit-error';
import {
  LlmAttemptBudget,
  normalizeMaxTotalProviderAttempts,
} from './attempt-budget';
import {
  createLlmExecutionFailureTracker,
  type LlmExecutionFailureClassification,
} from './failure-attribution';

const FEATURE = 'FREE_FORM_CHAT';

export interface EnvLlmExecutionConfig {
  /** `LLM_EXECUTION_ENABLED` — false bypasses admission, deadline, retry, and circuit controls; not a hard stop. */
  enabled: boolean;
  /** `LLM_MAX_CONCURRENT` — per-instance provider concurrency cap. */
  maxConcurrent: number;
  /** `LLM_GLOBAL_MAX_CONCURRENT` — Redis-distributed aggregate budget. */
  globalMaxConcurrent: number;
  /** `LLM_OPENAI_RETRY_MAX_ATTEMPTS` — retry budget. */
  maxAttempts: number;
  /** Shared actual provider-call budget for one top-level generation. */
  maxTotalProviderAttempts?: number;
  /** `LLM_OPENAI_RETRY_BACKOFF_MS` — base backoff between attempts. */
  baseBackoffMs: number;
  /** `LLM_OPENAI_RETRY_MAX_DELAY_MS` — ceiling on the pre-jitter backoff. */
  retryMaxDelayMs: number;
  /** `LLM_REQUEST_TIMEOUT_MS` — per-request deadline. */
  requestTimeoutMs: number;
  /** `LLM_RETRY_PER_ATTEMPT_TIMEOUT_MS` — cap on each retry attempt. */
  perAttemptTimeoutMs: number;
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

export interface LlmAdmissionRedisSource {
  getNativeClient(): Redis | null;
  isConfiguredEnabled?(): boolean;
}

type RedisSource = Redis | LlmAdmissionRedisSource;

function isRedisSource(source: RedisSource): source is LlmAdmissionRedisSource {
  return (
    typeof (source as { getNativeClient?: unknown }).getNativeClient ===
    'function'
  );
}

function resolveRedis(source: RedisSource): Redis | null {
  return isRedisSource(source) ? source.getNativeClient() : source;
}

function createRedisGlobalPort(source: RedisSource): LlmAdmissionGlobalPort {
  return {
    acquire: (
      limit,
      portLogger,
      options?: {
        metrics?: {
          incrementCounter(name: string, labels?: Record<string, string>): void;
        };
        signal?: AbortSignal;
        waitBudgetMs?: number;
        maxRetries?: number;
        retryDelayMs?: number;
        leaseMs?: number;
      },
    ) => {
      const redis = resolveRedis(source);
      if (!redis) {
        throw new LlmOverloadError('redis_unavailable');
      }
      return acquireRedisSlot(redis, REDIS_SLOT_KEY, limit, portLogger, {
        metrics: options?.metrics,
        signal: options?.signal,
        leaseMs: options?.leaseMs,
        maxRetries: options?.maxRetries,
        retryDelayMs: options?.retryDelayMs,
        waitBudgetMs: options?.waitBudgetMs,
      });
    },
  };
}

export function createLlmAdmissionCoordinator(
  config: EnvLlmExecutionConfig,
  logger: SlotLogger,
  metrics?: AdmissionMetrics,
  redis?: RedisSource | null,
): LlmAdmissionCoordinator {
  if (
    config.globalConcurrencyEnabled &&
    redis &&
    isRedisSource(redis) &&
    redis.isConfiguredEnabled &&
    !redis.isConfiguredEnabled()
  ) {
    throw new Error(
      'LLM_GLOBAL_CONCURRENCY_ENABLED=true requires Redis to be configured — refusing to start with the aggregate limit silently bypassed (#867)',
    );
  }
  return new LlmAdmissionCoordinator(
    config,
    logger,
    metrics,
    config.globalConcurrencyEnabled && redis
      ? createRedisGlobalPort(redis)
      : null,
  );
}

/**
 * Default `LlmExecutionPort` for apps without their own execution service
 * (Discord/Zalo chat + reports). Reads the same `LLM_EXECUTION_*` contract as
 * the Messenger app's `LlmExecutionConfigService` — one documented
 * execution-control path for every LLM feature:
 *  - enable flag (off = uncontrolled passthrough, not a hard stop)
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
  admissionCoordinator?: LlmAdmissionCoordinator,
): LlmExecutionPort {
  if (
    config.globalConcurrencyEnabled &&
    !config.redis &&
    !admissionCoordinator
  ) {
    throw new Error(
      'LLM_GLOBAL_CONCURRENCY_ENABLED=true requires a Redis client — refusing to start with the aggregate limit silently bypassed (#389)',
    );
  }
  const nativeRedis = config.globalConcurrencyEnabled
    ? (config.redis ?? null)
    : null;
  const admission =
    admissionCoordinator ??
    createLlmAdmissionCoordinator(config, logger, metrics, nativeRedis);
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

  const recordFailure = (
    classification: LlmExecutionFailureClassification,
  ): void => {
    if (classification.kind !== 'provider') {
      halfOpenInFlight = false;
      return;
    }

    metrics?.observeExecutionCircuitFailure?.(classification.errorClass);
    if (!classification.countsForCircuit) {
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
      fn: (
        signal?: AbortSignal,
        attemptBudget?: LlmAttemptBudget,
      ) => Promise<T>,
      meta: {
        feature: string;
        correlationId?: string;
        signal?: AbortSignal;
        attemptBudget?: LlmAttemptBudget;
        attempt?: LlmExecutionAttempt;
        retryCause?: LlmExecutionRetryCause;
        executionMode?: LlmExecutionMode;
      },
    ): Promise<T> => {
      if (!config.enabled) {
        if (meta?.executionMode === 'classifier') {
          throw new LlmExecutionDisabledError();
        }
        return fn(undefined, undefined);
      }
      const attemptBudget =
        meta?.attemptBudget ??
        new LlmAttemptBudget(
          normalizeMaxTotalProviderAttempts(config.maxTotalProviderAttempts),
        );
      const ownsAttemptBudget = meta?.attemptBudget === undefined;
      const isClassifier = meta?.executionMode === 'classifier';
      if (!isClassifier) assertCircuitAvailable();

      // One deadline covers admission, the optional Redis slot, retries, and
      // the provider request; no nested layer gets a fresh timeout budget.
      const deadlineSignal = AbortSignal.timeout(config.requestTimeoutMs);
      const signal = meta?.signal
        ? AbortSignal.any([meta.signal, deadlineSignal])
        : deadlineSignal;
      const failureTracker = createLlmExecutionFailureTracker({
        callerSignal: meta?.signal,
        deadlineSignal,
        attemptBudget,
      });

      const attempt = meta?.attempt ?? 'initial';
      const isBackground = !INTERACTIVE_LLM_FEATURES.has(meta?.feature ?? '');
      let backgroundAdmissionRecorded = false;
      const recordCapacityOverload = (): void => {
        if (isBackground && !backgroundAdmissionRecorded) {
          metrics?.observeBackgroundAdmission?.(
            meta?.feature ?? 'unknown',
            attempt,
            'capacity_overload',
          );
          backgroundAdmissionRecorded = true;
        }
      };
      let admissionLease: Awaited<
        ReturnType<LlmAdmissionCoordinator['acquire']>
      >;
      try {
        admissionLease = await admission.acquire(
          meta?.feature ?? FEATURE,
          signal,
        );
      } catch (error) {
        // A half-open probe may be rejected before a provider call (queue or
        // Redis failure); do not leave the execution circuit wedged forever.
        if (!isClassifier) halfOpenInFlight = false;
        if (error instanceof LlmOverloadError) {
          if (error.reason !== 'redis_unavailable') {
            recordCapacityOverload();
          }
        }
        throw error;
      }
      try {
        let attemptCount = 0;
        if (isBackground && !backgroundAdmissionRecorded) {
          metrics?.observeBackgroundAdmission?.(
            meta?.feature ?? 'unknown',
            attempt,
            'admitted',
          );
          backgroundAdmissionRecorded = true;
          if (attempt === 'retry' && meta?.retryCause === 'capacity_overload') {
            metrics?.observeOverloadRegeneration?.(meta?.feature ?? 'unknown');
          }
        }
        if (isClassifier) {
          try {
            attemptBudget.consume();
            const result = await fn(signal, attemptBudget);
            metrics?.observeRetryAttempts?.(1, { outcome: 'success' });
            if (ownsAttemptBudget) {
              metrics?.observeTotalProviderAttempts?.(
                attemptBudget.attemptsUsed,
                {
                  feature: meta?.feature ?? FEATURE,
                  outcome: 'success',
                },
              );
            }
            return result;
          } catch (error) {
            metrics?.observeRetryAttempts?.(1, { outcome: 'exhausted' });
            if (ownsAttemptBudget) {
              metrics?.observeTotalProviderAttempts?.(
                attemptBudget.attemptsUsed,
                {
                  feature: meta?.feature ?? FEATURE,
                  outcome: attemptBudget.exhausted
                    ? 'budget_exhausted'
                    : 'error',
                },
              );
            }
            throw error;
          } finally {
            attemptBudget.completeProviderAttempt();
          }
        }
        try {
          const result = await retryWithBackoff(
            (attemptSignal) => {
              attemptCount += 1;
              return failureTracker.run(() =>
                fn(attemptSignal ?? signal, attemptBudget),
              );
            },
            {
              maxAttempts: config.maxAttempts,
              baseDelayMs: config.baseBackoffMs,
              backoff: cappedExponentialBackoff(
                config.baseBackoffMs,
                config.retryMaxDelayMs,
              ),
              isRetryable: (error) => adapter.isRetryableError(error),
              onRetry: (attempt, backoffMs, error) => {
                failureTracker.resetForRetry();
                logger.warn(
                  `LLM provider retry feature=${
                    meta?.feature ?? FEATURE
                  } correlation=${
                    meta?.correlationId ?? 'n/a'
                  } attempt=${attempt}/${config.maxAttempts} backoffMs=${backoffMs}: ${errorMessage(
                    error,
                  )}`,
                );
              },
              signal,
              perAttemptTimeoutMs: config.perAttemptTimeoutMs,
              attemptBudget,
            },
          );
          metrics?.observeRetryAttempts?.(attemptCount, {
            outcome: 'success',
          });
          if (ownsAttemptBudget) {
            metrics?.observeTotalProviderAttempts?.(
              attemptBudget.attemptsUsed,
              {
                feature: meta?.feature ?? FEATURE,
                outcome: 'success',
              },
            );
          }
          recordSuccess();
          return result;
        } catch (error) {
          metrics?.observeRetryAttempts?.(attemptCount, {
            outcome: 'exhausted',
          });
          if (ownsAttemptBudget) {
            metrics?.observeTotalProviderAttempts?.(
              attemptBudget.attemptsUsed,
              {
                feature: meta?.feature ?? FEATURE,
                outcome: attemptBudget.exhausted ? 'budget_exhausted' : 'error',
              },
            );
          }
          recordFailure(failureTracker.classify(error, adapter));
          throw error;
        }
      } catch (error) {
        if (
          error instanceof LlmOverloadError &&
          error.reason !== 'redis_unavailable'
        ) {
          recordCapacityOverload();
        }
        throw error;
      } finally {
        if (!isClassifier) halfOpenInFlight = false;
        await admissionLease.release();
      }
    },
  };
}
