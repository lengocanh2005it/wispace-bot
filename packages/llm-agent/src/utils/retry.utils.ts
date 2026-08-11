/** Returns true if the error represents an AbortSignal cancellation. */
export function isAbortError(error: unknown): boolean {
  if (error !== null && typeof error === 'object' && 'name' in error) {
    return (error as { name?: string }).name === 'AbortError';
  }
  return false;
}

/** Sleep for `ms` milliseconds, resolving early or aborting if `signal` fires. */
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
