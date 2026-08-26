import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common';
import CircuitBreaker from 'opossum';
import {
  acquireRedisSlot,
  admissionWaitBudgetMs,
  retryWithBackoff,
  BoundedAdmissionQueue,
  LlmOverloadError,
  type AdmissionTicket,
  type LlmProviderAdapter,
} from '@wispace/llm-agent';
import { MetricsService } from '@messenger/modules/metrics/metrics.service';
import { LlmExecutionConfigService } from './llm-execution-config.service';
import type { LlmExecutionContext } from '../types/llm-execution.types';
import { withTimeout } from '@messenger/shared/utils/promise-timeout.utils';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common';
import type Redis from 'ioredis';

export type {
  LlmExecutionFeature,
  LlmExecutionContext,
} from '../types/llm-execution.types';

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
    private readonly metrics: MetricsService,
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
        timeout: this.config.getRequestTimeoutMs() + 5_000,
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

    const startedAtMs = Date.now();
    let ticket: AdmissionTicket;
    try {
      ticket = await this.queue.acquire({
        signal: context?.signal,
        waitBudgetMs: admissionWaitBudgetMs(this.budgets, context?.feature),
      });
    } catch (error) {
      if (error instanceof LlmOverloadError) {
        this.metrics.incLlmAdmissionRejected(error.reason);
      }
      throw error;
    }
    this.metrics.observeLlmAdmissionWait((Date.now() - startedAtMs) / 1000);

    let releaseGlobal: (() => Promise<void>) | undefined;
    try {
      if (this.globalRedis) {
        // Compose deadline + caller signal BEFORE slot acquisition so
        // cancellation aborts the retry loop (#364 parity on Messenger).
        const deadlineSignal = AbortSignal.timeout(
          this.config.getRequestTimeoutMs(),
        );
        const acquireSignal = context?.signal
          ? AbortSignal.any([context.signal, deadlineSignal])
          : deadlineSignal;
        releaseGlobal = await acquireRedisSlot(
          this.globalRedis,
          'llm:concurrency:global',
          this.config.getGlobalMaxConcurrent(),
          { warn: (message) => this.logger.warn(message) },
          {
            signal: acquireSignal,
            waitBudgetMs: admissionWaitBudgetMs(this.budgets, context?.feature),
          },
        );
      }

      return (await this.breaker.fire(fn, context)) as Promise<T>;
    } finally {
      await releaseGlobal?.();
      ticket.release();
    }
  }

  private async runWithRetry<T>(
    fn: (signal?: AbortSignal) => Promise<T>,
    context?: LlmExecutionContext,
  ): Promise<T> {
    const maxAttempts = this.config.getRetryMaxAttempts();
    const baseBackoffMs = this.config.getRetryBackoffMs();
    const timeoutMs = this.config.getRequestTimeoutMs();
    const feature = context?.feature ?? 'unknown';
    const correlation = context?.correlationId ?? 'n/a';

    // Per-call deadline + optional caller signal: cancels retries and backoff
    // sleeps immediately AND aborts the in-flight provider request — a timeout
    // never leaves the original request running while a retry starts.
    const deadlineSignal = AbortSignal.timeout(timeoutMs);
    const signal = context?.signal
      ? AbortSignal.any([context.signal, deadlineSignal])
      : deadlineSignal;

    // ponytail: shared retry helper from llm-agent (was a local sleep+backoff copy)
    return retryWithBackoff(
      () =>
        this.metrics.timeLlmExecution(feature, () =>
          withTimeout(() => fn(signal), timeoutMs, 'LLM request'),
        ),
      {
        maxAttempts,
        baseDelayMs: baseBackoffMs,
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
