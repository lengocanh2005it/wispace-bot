import {
  isAbortError,
  jitteredDelayMs,
  sleep,
} from '@wispace/bot-common/utils';

export { isAbortError, sleep } from '@wispace/bot-common/utils';

export interface RetryBackoffOptions {
  maxAttempts: number;
  baseDelayMs: number;
  isRetryable: (error: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  /** Backoff for attempt (1-based). Default: exponential `baseDelayMs * 2^(attempt-1)`.
   *  A caller that needs a ceiling caps here (before jitter). */
  backoff?: (attempt: number) => number;
  /** Injectable RNG for the equal-jitter spread — tests pass a stub, production
   *  uses `Math.random`. */
  rng?: () => number;
  /** Optional AbortSignal to cancel retries immediately. */
  signal?: AbortSignal;
}

/**
 * Exponential backoff (`baseDelayMs * 2^(attempt-1)`) clamped at `maxDelayMs`.
 * Pass as `RetryBackoffOptions.backoff` so the ceiling is applied *before* the
 * equal jitter — the shape every capped retry path in this repo uses.
 */
export function cappedExponentialBackoff(
  baseDelayMs: number,
  maxDelayMs: number,
): (attempt: number) => number {
  return (attempt) => Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
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
      const nominalMs = options.backoff
        ? options.backoff(attempt)
        : options.baseDelayMs * 2 ** (attempt - 1);
      // Equal jitter — spreads many requests that failed on the same upstream
      // error so their retries do not fire in the same instant.
      const delayMs = jitteredDelayMs(nominalMs, options.rng);
      options.onRetry?.(attempt, delayMs, error);
      await sleep(delayMs, options.signal);
    }
  }

  throw lastError;
}
