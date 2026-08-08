/**
 * Rejects with `${label} timed out after ${timeoutMs}ms` if the promise has
 * not settled within the window. Aborts the underlying operation on timeout
 * via AbortController.
 *
 * The `fn` receives an AbortSignal that is aborted on timeout. Pass the
 * signal to `fetch()` or other abortable operations.
 *
 * If a plain Promise is passed instead of a function, timeout only detaches
 * the caller (backward-compatible behavior).
 */
export function withTimeout<T>(
  fn: ((signal: AbortSignal) => Promise<T>) | Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const promise = typeof fn === 'function' ? fn(controller.signal) : fn;

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
