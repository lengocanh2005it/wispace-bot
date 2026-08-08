import CircuitBreaker from 'opossum';

export interface WithRetryOptions {
  /** Total retry attempts after the initial call (maxRetries=3 → 4 total calls). */
  maxRetries: number;
  /** Delay before the 2nd attempt in ms; doubles each retry (exponential backoff). */
  baseDelayMs: number;
  /** Return true if the error is transient and worth retrying. Defaults to always retry. */
  shouldRetry?: (error: unknown) => boolean;
  /** Called before each retry sleep — useful for logging. */
  onRetry?: (attempt: number, maxRetries: number, error: unknown) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: WithRetryOptions,
): Promise<T> {
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const hasRetriesLeft = attempt < opts.maxRetries;
      if (!hasRetriesLeft || !shouldRetry(error)) {
        throw error;
      }
      opts.onRetry?.(attempt + 1, opts.maxRetries, error);
      const delay =
        opts.baseDelayMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/** Retry on 5xx Wispace errors or transient network failures. Never retry 4xx. */
export function isWispaceRetryable(error: unknown): boolean {
  if (
    error !== null &&
    typeof error === 'object' &&
    'isRetryable' in error &&
    typeof error.isRetryable === 'function'
  ) {
    return (error as { isRetryable: () => boolean }).isRetryable();
  }
  return error instanceof TypeError; // network / DNS error
}

export { CircuitBreaker };

export interface CircuitBreakerOptions {
  /** Number of failures before opening the circuit. Default: 5. */
  threshold?: number;
  /** Time in ms to wait before trying again after circuit opens. Default: 60000. */
  cooldown?: number;
  /** Timeout per call in ms. Default: 10000. */
  timeout?: number;
}

/**
 * Create an opossum circuit breaker wrapped around an async function.
 * Usage:
 *   const breaker = createCircuitBreaker(fetchFn, { threshold: 5, cooldown: 60000 });
 *   const result = await breaker.fire(); // throws CircuitBreakerOpenError when circuit is open
 */
export function createCircuitBreaker<T>(
  fn: () => Promise<T>,
  opts: CircuitBreakerOptions = {},
): CircuitBreaker<T> {
  const breaker = new CircuitBreaker(fn, {
    timeout: opts.timeout ?? 10_000,
    errorThresholdPercentage: 50,
    resetTimeout: opts.cooldown ?? 60_000,
    volumeThreshold: opts.threshold ?? 5,
  });

  return breaker;
}

/**
 * Create a circuit breaker that wraps withRetry for Wispace API calls.
 * When the circuit is open, calls fail fast without attempting retries.
 * When closed, the full retry logic runs normally.
 */
export function createWispaceBreaker<T>(
  fn: () => Promise<T>,
  retryOpts: WithRetryOptions,
  cbOpts: CircuitBreakerOptions = {},
): CircuitBreaker<T> {
  return createCircuitBreaker(() => withRetry(fn, retryOpts), cbOpts);
}
