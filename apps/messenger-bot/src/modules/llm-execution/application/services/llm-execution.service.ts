import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common/masking';
import CircuitBreaker from 'opossum';
import {
  acquireRedisSlot,
  admissionWaitBudgetMs,
  cappedExponentialBackoff,
  retryWithBackoff,
  BoundedAdmissionQueue,
  LlmOverloadError,
  LlmProviderCircuitOpenError,
  type AdmissionTicket,
  type LlmProviderAdapter,
} from '@wispace/llm-agent';
import { BotMetricsService } from '@wispace/bot-metrics';
import { LlmExecutionConfigService } from './llm-execution-config.service';
import type { LlmExecutionContext } from '../types/llm-execution.types';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import type Redis from 'ioredis';

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

@Injectable()
export class LlmExecutionService {
  private readonly logger = new Logger(LlmExecutionService.name);
  private readonly queue: BoundedAdmissionQueue;
  private readonly globalRedis: Redis | null;
  private readonly budgets: {
    chatAdmissionWaitMs: number;
    backgroundAdmissionWaitMs: number;
  };
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly config: LlmExecutionConfigService,
    private readonly metrics: BotMetricsService,
    @Inject('LLM_PROVIDER_ADAPTER')
    private readonly adapter: LlmProviderAdapter,
    @Optional()
    @Inject(REDIS_CLIENT)
    redisClient?: RedisClientPort | null,
  ) {
    this.queue = new BoundedAdmissionQueue(
      this.config.getMaxConcurrent(),
      this.config.getMaxQueueDepth(),
    );
    this.budgets = {
      chatAdmissionWaitMs: this.config.getChatAdmissionWaitMs(),
      backgroundAdmissionWaitMs: this.config.getBackgroundAdmissionWaitMs(),
    };

    // Fail closed at startup when the aggregate budget is enabled without its
    // Redis dependency — never silently bypass the shared limit (#389).
    this.globalRedis = this.config.isGlobalConcurrencyEnabled()
      ? (redisClient?.getNativeClient() ?? null)
      : null;
    if (this.config.isGlobalConcurrencyEnabled() && !this.globalRedis) {
      throw new Error(
        'LLM_GLOBAL_CONCURRENCY_ENABLED=true requires a configured Redis client — refusing to start with the aggregate limit silently bypassed (#389)',
      );
    }

    this.breaker = new CircuitBreaker(
      (fn: () => Promise<unknown>, context?: LlmExecutionContext) =>
        this.runWithRetry(fn, context),
      {
        // The request signal is the single timeout budget. A second Opossum
        // timeout would make retries outlive the caller's deadline.
        timeout: false,
        errorThresholdPercentage: 50,
        resetTimeout: 60_000,
        volumeThreshold: 3,
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
    fn: (signal?: AbortSignal) => Promise<T>,
    context?: LlmExecutionContext,
  ): Promise<T> {
    if (!this.config.isEnabled()) {
      return fn(undefined);
    }

    // Create the one deadline before admission so queueing, Redis acquisition,
    // provider retries, and the provider call share the same remaining budget.
    const deadlineSignal = AbortSignal.timeout(
      this.config.getRequestTimeoutMs(),
    );
    const signal = context?.signal
      ? AbortSignal.any([context.signal, deadlineSignal])
      : deadlineSignal;
    const executionContext: LlmExecutionContext = {
      feature: context?.feature ?? 'unknown',
      ...(context?.correlationId
        ? { correlationId: context.correlationId }
        : {}),
      signal,
    };

    const startedAtMs = Date.now();
    let ticket: AdmissionTicket;
    try {
      ticket = await this.queue.acquire({
        signal,
        waitBudgetMs: admissionWaitBudgetMs(
          this.budgets,
          executionContext.feature,
        ),
      });
    } catch (error) {
      if (error instanceof LlmOverloadError) {
        this.metrics.incLlmAdmissionRejected(error.reason);
        this.metrics.setLlmAdmissionQueueDepth(this.queue.waitingCount);
      }
      throw error;
    }
    this.metrics.observeLlmAdmissionWait((Date.now() - startedAtMs) / 1000);
    this.metrics.setLlmAdmissionQueueDepth(this.queue.waitingCount);

    let releaseGlobal: (() => Promise<void>) | undefined;
    try {
      if (this.globalRedis) {
        // Cancellation aborts the Redis retry loop and avoids holding a local
        // admission slot while spinning (#364 parity on Messenger).
        releaseGlobal = await acquireRedisSlot(
          this.globalRedis,
          'llm:concurrency:global',
          this.config.getGlobalMaxConcurrent(),
          { warn: (message) => this.logger.warn(message) },
          {
            metrics: this.metrics.llmAdmission,
            signal,
            waitBudgetMs: admissionWaitBudgetMs(
              this.budgets,
              executionContext.feature,
            ),
          },
        );
      }

      try {
        return (await this.breaker.fire(fn, executionContext)) as Promise<T>;
      } catch (error) {
        if (isOpossumOpenError(error)) {
          throw new LlmProviderCircuitOpenError('open');
        }
        throw error;
      }
    } finally {
      await releaseGlobal?.();
      ticket.release();
      this.metrics.setLlmAdmissionQueueDepth(this.queue.waitingCount);
    }
  }

  private async runWithRetry<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    context?: LlmExecutionContext,
  ): Promise<T> {
    const maxAttempts = this.config.getRetryMaxAttempts();
    const baseBackoffMs = this.config.getRetryBackoffMs();
    const maxDelayMs = this.config.getRetryMaxDelayMs();
    const feature = context?.feature ?? 'unknown';
    const correlation = context?.correlationId ?? 'n/a';
    const signal = context?.signal;

    // ponytail: shared retry helper from llm-agent (was a local sleep+backoff copy)
    return retryWithBackoff(
      () => this.metrics.timeLlmExecution(feature, () => fn(signal)),
      {
        maxAttempts,
        baseDelayMs: baseBackoffMs,
        backoff: cappedExponentialBackoff(baseBackoffMs, maxDelayMs),
        isRetryable: (error) => this.adapter.isRetryableError(error),
        onRetry: (attempt, backoffMs, error) =>
          this.logger.warn(
            `LLM provider retry feature=${feature} correlation=${correlation} attempt=${attempt}/${maxAttempts} backoffMs=${backoffMs}: ${errorMessage(
              error,
            )}`,
          ),
        signal,
      },
    );
  }
}
