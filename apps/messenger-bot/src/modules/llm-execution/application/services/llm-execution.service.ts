import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common';
import pLimit from 'p-limit';
import CircuitBreaker from 'opossum';
import { retryWithBackoff, type LlmProviderAdapter } from '@wispace/llm-agent';
import { MetricsService } from '@messenger/modules/metrics/metrics.service';
import { LlmExecutionConfigService } from './llm-execution-config.service';
import type { LlmExecutionContext } from '../types/llm-execution.types';
import { RedisConcurrencyLimiter } from '../../infrastructure/redis-concurrency-limiter';
import { withTimeout } from '@messenger/shared/utils/promise-timeout.utils';

export type {
  LlmExecutionFeature,
  LlmExecutionContext,
} from '../types/llm-execution.types';

@Injectable()
export class LlmExecutionService {
  private readonly logger = new Logger(LlmExecutionService.name);
  private limiter: ReturnType<typeof pLimit>;
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly config: LlmExecutionConfigService,
    private readonly metrics: MetricsService,
    @Inject('LLM_PROVIDER_ADAPTER')
    private readonly adapter: LlmProviderAdapter,
    @Optional()
    @Inject(RedisConcurrencyLimiter)
    private readonly globalLimiter?: RedisConcurrencyLimiter,
  ) {
    this.limiter = pLimit(this.config.getMaxConcurrent());

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
   * Runs an LLM call with optional global concurrency cap (p-limit), circuit
   * breaker, and retry on retryable errors (429 / 5xx). Each LLM request
   * should pass through here.
   */
  async run<T>(
    fn: () => Promise<T>,
    context?: LlmExecutionContext,
  ): Promise<T> {
    if (!this.config.isEnabled()) {
      return fn();
    }

    if (this.globalLimiter) {
      const globalLimit = this.config.getGlobalMaxConcurrent();
      const release = await this.globalLimiter.acquire('global', globalLimit);
      try {
        return await this.limiter(
          () => this.breaker.fire(fn, context) as Promise<T>,
        );
      } finally {
        await release();
      }
    }

    return this.limiter(() => this.breaker.fire(fn, context) as Promise<T>);
  }

  private async runWithRetry<T>(
    fn: () => Promise<T>,
    context?: LlmExecutionContext,
  ): Promise<T> {
    const maxAttempts = this.config.getRetryMaxAttempts();
    const baseBackoffMs = this.config.getRetryBackoffMs();
    const timeoutMs = this.config.getRequestTimeoutMs();
    const feature = context?.feature ?? 'unknown';
    const correlation = context?.correlationId ?? 'n/a';

    // ponytail: shared retry helper from llm-agent (was a local sleep+backoff copy)
    return retryWithBackoff(
      () =>
        this.metrics.timeLlmExecution(feature, () =>
          withTimeout(
            () => Promise.resolve().then(fn),
            timeoutMs,
            'LLM request',
          ),
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
      },
    );
  }
}
