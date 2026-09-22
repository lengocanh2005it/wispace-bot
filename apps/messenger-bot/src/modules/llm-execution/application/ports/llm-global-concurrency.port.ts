export interface LlmGlobalConcurrencyMetricsPort {
  incrementCounter(name: string, labels?: Record<string, string>): void;
}

export interface LlmGlobalConcurrencyPort {
  acquire(
    limit: number,
    logger: { warn(message: string): void },
    options?: {
      metrics?: LlmGlobalConcurrencyMetricsPort;
      signal?: AbortSignal;
      waitBudgetMs?: number;
      maxRetries?: number;
      retryDelayMs?: number;
      leaseMs?: number;
    },
  ): Promise<() => Promise<void>>;
}

export const LLM_GLOBAL_CONCURRENCY_PORT = Symbol(
  'LLM_GLOBAL_CONCURRENCY_PORT',
);
