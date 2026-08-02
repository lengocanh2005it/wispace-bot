import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import pLimit from 'p-limit';
import { retryWithBackoff, type LlmProviderAdapter } from '@wispace/llm-agent';
import { MetricsService } from '@messenger/modules/metrics/metrics.service';
import { LlmExecutionConfigService } from './llm-execution-config.service';
import type { LlmExecutionContext } from '../types/llm-execution.types';
import { RedisConcurrencyLimiter } from '../../infrastructure/redis-concurrency-limiter';

export type {
  LlmExecutionFeature,
  LlmExecutionContext,
} from '../types/llm-execution.types';

function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`LLM request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve().then(fn), timeoutPromise]).finally(
    () => {
      if (timer) {
        clearTimeout(timer);
      }
    },
  );
}

@Injectable()
export class LlmExecutionService {
  private readonly logger = new Logger(LlmExecutionService.name);
  private limiter: ReturnType<typeof pLimit>;

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
  }

  /**
   * Runs an LLM call with optional global concurrency cap (p-limit) and retry
   * on retryable errors (429 / 5xx). Each LLM request should pass through here.
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
        return await this.limiter(() => this.runWithRetry(fn, context));
      } finally {
        await release();
      }
    }

    return this.limiter(() => this.runWithRetry(fn, context));
  }

  /** Rebuild limiter when config changes at runtime (tests). */
  refreshLimiter(): void {
    this.limiter = pLimit(this.config.getMaxConcurrent());
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
          withTimeout(fn, timeoutMs),
        ),
      {
        maxAttempts,
        baseDelayMs: baseBackoffMs,
        isRetryable: (error) => this.adapter.isRetryableError(error),
        onRetry: (attempt, backoffMs, error) =>
          this.logger.warn(
            `LLM provider retry feature=${feature} correlation=${correlation} attempt=${attempt}/${maxAttempts} backoffMs=${backoffMs}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
      },
    );
  }
}
