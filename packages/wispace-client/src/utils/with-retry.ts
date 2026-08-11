import CircuitBreaker from 'opossum';

export function isAbortError(error: unknown): boolean {
  if (error !== null && typeof error === 'object' && 'name' in error) {
    return (error as { name?: string }).name === 'AbortError';
  }
  return false;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const rejectWithReason = (reason: unknown) => {
      reject(reason instanceof Error ? reason : new Error('Aborted'));
    };

    if (signal?.aborted) {
      return rejectWithReason(signal.reason);
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      rejectWithReason(signal?.reason);
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface WithRetryOptions {
  /** Total retry attempts after the initial call (maxRetries=3 → 4 total calls). */
  maxRetries: number;
  /** Delay before the 2nd attempt in ms; doubles each retry (exponential backoff). */
  baseDelayMs: number;
  /** Return true if the error is transient and worth retrying. Defaults to always retry. */
  shouldRetry?: (error: unknown) => boolean;
  /** Called before each retry sleep — useful for logging. */
  onRetry?: (attempt: number, maxRetries: number, error: unknown) => void;
  /** Optional signal to cancel retries immediately. */
  signal?: AbortSignal;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: WithRetryOptions,
): Promise<T> {
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason ?? lastError ?? new Error('Aborted');
    }
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const hasRetriesLeft = attempt < opts.maxRetries;
      if (
        opts.signal?.aborted ||
        isAbortError(error) ||
        !hasRetriesLeft ||
        !shouldRetry(error)
      ) {
        throw error;
      }
      opts.onRetry?.(attempt + 1, opts.maxRetries, error);
      const delay =
        opts.baseDelayMs * Math.pow(2, attempt) * (0.5 + Math.random() * 0.5);
      await sleep(delay, opts.signal);
    }
  }
  if (opts.signal?.aborted || isAbortError(lastError)) {
    throw lastError ?? opts.signal?.reason ?? new Error('Aborted');
  }
  throw lastError;
}

/** Retry on 5xx Wispace errors or transient network failures. Never retry 4xx or cancellation. */
export function isWispaceRetryable(error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
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
  /** Timeout per call in ms. Default: 60000 (total budget). False to disable opossum internal timer. */
  timeout?: number | false;
}

/**
 * Create an opossum circuit breaker wrapped around an async function.
 * Usage:
 *   const breaker = createCircuitBreaker(fetchFn, { threshold: 5, cooldown: 60000 });
 *   const result = await breaker.fire(); // throws CircuitBreakerOpenError when circuit is open
 */
export function createCircuitBreaker<T>(
  fn: (...args: any[]) => Promise<T>,
  opts: CircuitBreakerOptions = {},
): CircuitBreaker<any[], T> {
  const breaker = new CircuitBreaker(fn, {
    timeout: opts.timeout ?? 60_000,
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
