/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryBackoffOptions {
  maxAttempts: number;
  baseDelayMs: number;
  isRetryable: (error: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  /** Backoff for attempt (1-based). Default: exponential `baseDelayMs * 2^(attempt-1)`. */
  backoff?: (attempt: number) => number;
}

/**
 * Retry `fn` with backoff while errors are retryable. Throws the last error
 * when attempts run out or the error is not retryable.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryBackoffOptions,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!options.isRetryable(error) || attempt >= options.maxAttempts) {
        throw error;
      }
      const delayMs = options.backoff
        ? options.backoff(attempt)
        : options.baseDelayMs * 2 ** (attempt - 1);
      options.onRetry?.(attempt, delayMs, error);
      await sleep(delayMs);
    }
  }

  throw lastError;
}
