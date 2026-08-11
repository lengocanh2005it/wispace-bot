import { isAbortError, sleep } from '@wispace/bot-common';

export { isAbortError, sleep } from '@wispace/bot-common';

export interface RetryBackoffOptions {
  maxAttempts: number;
  baseDelayMs: number;
  isRetryable: (error: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  /** Backoff for attempt (1-based). Default: exponential `baseDelayMs * 2^(attempt-1)`. */
  backoff?: (attempt: number) => number;
  /** Optional AbortSignal to cancel retries immediately. */
  signal?: AbortSignal;
}

/**
 * Retry `fn` with backoff while errors are retryable. Throws the last error
 * when attempts run out or the error is not retryable or the signal is aborted.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryBackoffOptions,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('Aborted');
    }

    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (
        options.signal?.aborted ||
        isAbortError(error) ||
        !options.isRetryable(error) ||
        attempt >= options.maxAttempts
      ) {
        throw error;
      }
      const delayMs = options.backoff
        ? options.backoff(attempt)
        : options.baseDelayMs * 2 ** (attempt - 1);
      options.onRetry?.(attempt, delayMs, error);
      await sleep(delayMs, options.signal);
    }
  }

  throw lastError;
}
