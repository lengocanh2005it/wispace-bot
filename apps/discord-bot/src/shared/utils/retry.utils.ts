/**
 * Retry an async operation with linear backoff, rethrowing the last error
 * when all attempts fail. Shared by the OAuth callback and the link-reconcile
 * cron (identical retry semantics — no per-site copies).
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelayMs * attempt),
        );
      }
    }
  }
  throw lastError;
}
