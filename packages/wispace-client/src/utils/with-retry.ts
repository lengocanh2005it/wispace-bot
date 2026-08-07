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
