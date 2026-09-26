import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common/masking';
import { isAbortError } from '@wispace/bot-common/utils';
import CircuitBreaker from 'opossum';
import {
  INTERACTIVE_LLM_FEATURES,
  cappedExponentialBackoff,
  retryWithBackoff,
  LlmOverloadError,
  LlmExecutionDisabledError,
  LlmAdmissionCoordinator,
  LlmProviderCircuitOpenError,
  LlmAttemptBudget,
  createLlmExecutionFailureTracker,
} from '@wispace/llm-agent/core';
import type {
  LlmProviderAdapter,
  LlmExecutionFailureClassification,
  LlmExecutionFailureTracker,
} from '@wispace/llm-agent/core';
import { BotMetricsService } from '@wispace/bot-metrics';
import { LlmExecutionConfigService } from './llm-execution-config.service';
import type { LlmExecutionContext } from '../types/llm-execution.types';
import {
  LLM_GLOBAL_CONCURRENCY_PORT,
  type LlmGlobalConcurrencyPort,
} from '../ports/llm-global-concurrency.port';

export type {
  LlmExecutionFeature,
  LlmExecutionContext,
} from '../types/llm-execution.types';

function isOpossumOpenError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'EOPENBREAKER'
  );
}

type BreakerExecutionContext = LlmExecutionContext & {
  failureClassification?: LlmExecutionFailureClassification;
  failureTracker?: LlmExecutionFailureTracker;
};

@Injectable()
export class LlmExecutionService {
  private readonly logger = new Logger(LlmExecutionService.name);
  private readonly admission: LlmAdmissionCoordinator;
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly config: LlmExecutionConfigService,
    private readonly metrics: BotMetricsService,
    @Inject('LLM_PROVIDER_ADAPTER')
    private readonly adapter: LlmProviderAdapter,
    @Optional()
    @Inject(LLM_GLOBAL_CONCURRENCY_PORT)
    private readonly globalConcurrencyPort?: LlmGlobalConcurrencyPort | null,
  ) {
    // Fail closed at startup when the aggregate budget is enabled without its
    // Redis dependency — never silently bypass the shared limit (#389).
    if (
      this.config.isGlobalConcurrencyEnabled() &&
      !this.globalConcurrencyPort
    ) {
      throw new Error(
        'LLM_GLOBAL_CONCURRENCY_ENABLED=true requires a configured Redis client — refusing to start with the aggregate limit silently bypassed (#389)',
      );
    }

    this.admission = new LlmAdmissionCoordinator(
      {
        enabled: this.config.isEnabled(),
        maxConcurrent: this.config.getMaxConcurrent(),
        maxQueueDepth: this.config.getMaxQueueDepth(),
        chatAdmissionWaitMs: this.config.getChatAdmissionWaitMs(),
        backgroundAdmissionWaitMs: this.config.getBackgroundAdmissionWaitMs(),
        globalMaxConcurrent: this.config.getGlobalMaxConcurrent(),
        globalConcurrencyEnabled: this.config.isGlobalConcurrencyEnabled(),
        requestTimeoutMs: this.config.getRequestTimeoutMs(),
      },
      this.logger,
      this.metrics.llmAdmission,
      this.globalConcurrencyPort,
    );

    this.breaker = new CircuitBreaker(
      (
        fn: (
          signal?: AbortSignal,
          attemptBudget?: LlmAttemptBudget,
        ) => Promise<unknown>,
        context?: BreakerExecutionContext,
      ) => this.runWithRetry(fn, context),
      {
        // The request signal is the single timeout budget. A second Opossum
        // timeout would make retries outlive the caller's deadline.
        timeout: false,
        errorThresholdPercentage: 50,
        resetTimeout: 60_000,
        volumeThreshold: 3,
        errorFilter: (_error: unknown, ...args: unknown[]) => {
          const context = args[1] as BreakerExecutionContext | undefined;
          return context?.failureClassification?.countsForCircuit !== true;
        },
      },
    );

    this.breaker.on('open', () => {
      this.logger.warn('LLM provider circuit breaker OPEN — failing fast');
    });
    this.breaker.on('halfOpen', () => {
      this.logger.log('LLM provider circuit breaker half-open — testing');
    });
    this.breaker.on('close', () => {
      this.logger.log('LLM provider circuit breaker closed — recovered');
    });
  }

  /**
   * Runs an LLM call through bounded admission (#389): local wait-budgeted
   * queue, optional Redis-global slot with caller-signal cancellation,
   * circuit breaker, and retry on retryable errors (429 / 5xx). Each LLM
   * request should pass through here.
   */
  async run<T>(
    fn: (signal?: AbortSignal, attemptBudget?: LlmAttemptBudget) => Promise<T>,
    context?: LlmExecutionContext,
  ): Promise<T> {
    if (!this.config.isEnabled()) {
      if (context?.executionMode === 'classifier') {
        throw new LlmExecutionDisabledError();
      }
      return fn(undefined, undefined);
    }

    const isClassifier = context?.executionMode === 'classifier';

    const attemptBudget =
      context?.attemptBudget ??
      new LlmAttemptBudget(
        isClassifier ? 1 : this.config.getMaxTotalProviderAttempts(),
      );
    const ownsAttemptBudget = context?.attemptBudget === undefined;

    // Create the one deadline before admission so queueing, Redis acquisition,
    // provider retries, and the provider call share the same remaining budget.
    const deadlineSignal = AbortSignal.timeout(
      this.config.getRequestTimeoutMs(),
    );
    const signal = context?.signal
      ? AbortSignal.any([context.signal, deadlineSignal])
      : deadlineSignal;
    const executionContext: BreakerExecutionContext = {
      feature: context?.feature ?? 'unknown',
      executionMode: context?.executionMode,
      ...(context?.correlationId
        ? { correlationId: context.correlationId }
        : {}),
      signal,
      attemptBudget,
      failureTracker: createLlmExecutionFailureTracker({
        callerSignal: context?.signal,
        deadlineSignal,
        attemptBudget,
      }),
    };

    const attempt = context?.attempt ?? 'initial';
    const isBackground = !INTERACTIVE_LLM_FEATURES.has(
      executionContext.feature,
    );
    let backgroundAdmissionRecorded = false;
    const recordCapacityOverload = (): void => {
      if (isBackground && !backgroundAdmissionRecorded) {
        this.metrics.observeLlmBackgroundAdmission?.(
          executionContext.feature,
          attempt,
          'capacity_overload',
        );
        backgroundAdmissionRecorded = true;
      }
    };
    let admissionLease: Awaited<ReturnType<LlmAdmissionCoordinator['acquire']>>;
    try {
      admissionLease = await this.admission.acquire(
        executionContext.feature,
        signal,
      );
    } catch (error) {
      if (error instanceof LlmOverloadError) {
        if (error.reason !== 'redis_unavailable') {
          recordCapacityOverload();
        }
      }
      throw error;
    }
    try {
      const attemptsBeforeExecution = attemptBudget.attemptsUsed;
      const attemptsForExecution = () =>
        Math.max(0, attemptBudget.attemptsUsed - attemptsBeforeExecution);
      if (isBackground && !backgroundAdmissionRecorded) {
        this.metrics.observeLlmBackgroundAdmission?.(
          executionContext.feature,
          attempt,
          'admitted',
        );
        backgroundAdmissionRecorded = true;
        if (
          attempt === 'retry' &&
          context?.retryCause === 'capacity_overload'
        ) {
          this.metrics.incLlmOverloadRegeneration?.(executionContext.feature);
        }
      }

      try {
        if (isClassifier) {
          try {
            attemptBudget.consume();
            const result = await this.metrics.timeLlmExecution(
              executionContext.feature,
              () => fn(signal, attemptBudget),
            );
            this.metrics.llmAdmission?.observeRetryAttempts?.(
              attemptsForExecution(),
              { outcome: 'success' },
            );
            if (ownsAttemptBudget) {
              this.metrics.incLlmTotalProviderAttempts?.(
                executionContext.feature,
                attemptBudget.attemptsUsed,
                'success',
              );
            }
            return result;
          } catch (error) {
            attemptBudget.recordFailure(error);
            this.metrics.llmAdmission?.observeRetryAttempts?.(
              attemptsForExecution(),
              { outcome: 'exhausted' },
            );
            if (ownsAttemptBudget) {
              this.metrics.incLlmTotalProviderAttempts?.(
                executionContext.feature,
                attemptBudget.attemptsUsed,
                'error',
              );
            }
            throw error;
          } finally {
            attemptBudget.completeProviderAttempt();
          }
        }

        try {
          const result = (await this.breaker.fire(
            fn,
            executionContext,
          )) as Promise<T>;
          this.metrics.llmAdmission?.observeRetryAttempts?.(
            attemptsForExecution(),
            { outcome: 'success' },
          );
          if (ownsAttemptBudget) {
            this.metrics.incLlmTotalProviderAttempts?.(
              executionContext.feature,
              attemptBudget.attemptsUsed,
              'success',
            );
          }
          return result;
        } catch (error) {
          this.metrics.llmAdmission?.observeRetryAttempts?.(
            attemptsForExecution(),
            { outcome: 'exhausted' },
          );
          if (ownsAttemptBudget) {
            this.metrics.incLlmTotalProviderAttempts?.(
              executionContext.feature,
              attemptBudget.attemptsUsed,
              attemptBudget.exhausted && !isAbortError(error)
                ? 'budget_exhausted'
                : 'error',
            );
          }
          throw error;
        }
      } catch (error) {
        if (isOpossumOpenError(error)) {
          throw new LlmProviderCircuitOpenError('open');
        }
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
      await admissionLease.release();
    }
  }

  private async runWithRetry<T>(
    fn: (signal?: AbortSignal, attemptBudget?: LlmAttemptBudget) => Promise<T>,
    context?: BreakerExecutionContext,
  ): Promise<T> {
    const maxAttempts = this.config.getRetryMaxAttempts();
    const baseBackoffMs = this.config.getRetryBackoffMs();
    const maxDelayMs = this.config.getRetryMaxDelayMs();
    const feature = context?.feature ?? 'unknown';
    const correlation = context?.correlationId ?? 'n/a';
    const signal = context?.signal;
    const attemptBudget = context?.attemptBudget;
    const failureTracker = context?.failureTracker;

    // ponytail: shared retry helper from llm-agent (was a local sleep+backoff copy)
    try {
      return await retryWithBackoff(
        (attemptSignal) => {
          const providerCall = () =>
            this.metrics.timeLlmExecution(feature, () =>
              fn(attemptSignal ?? signal, attemptBudget),
            );
          return failureTracker
            ? failureTracker.run(providerCall)
            : providerCall();
        },
        {
          maxAttempts,
          baseDelayMs: baseBackoffMs,
          backoff: cappedExponentialBackoff(baseBackoffMs, maxDelayMs),
          isRetryable: (error) => this.adapter.isRetryableError(error),
          onRetry: (attempt, backoffMs, error) => {
            failureTracker?.resetForRetry();
            this.logger.warn(
              `LLM provider retry feature=${feature} correlation=${correlation} attempt=${attempt}/${maxAttempts} backoffMs=${backoffMs}: ${errorMessage(
                error,
              )}`,
            );
          },
          signal,
          perAttemptTimeoutMs: this.config.getPerAttemptTimeoutMs(),
          attemptBudget,
        },
      );
    } catch (error) {
      if (failureTracker) {
        const classification = failureTracker.classify(error, this.adapter);
        context.failureClassification = classification;
        if (classification.kind === 'provider') {
          this.metrics.llmAdmission?.observeExecutionCircuitFailure?.(
            classification.errorClass,
          );
        }
      }
      throw error;
    }
  }
}
