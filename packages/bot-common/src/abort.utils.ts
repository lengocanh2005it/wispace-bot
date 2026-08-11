/** Returns true if the error represents a cancellation/deadline (AbortSignal or undici/opossum timeout). */
export function isAbortError(error: unknown): boolean {
  if (error !== null && typeof error === 'object' && 'name' in error) {
    const name = (error as { name?: string }).name;
    return name === 'AbortError' || name === 'TimeoutError';
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
