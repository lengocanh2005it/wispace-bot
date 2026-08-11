/**
 * Combine a caller signal with a per-attempt deadline into a single signal for
 * fetch. Each attempt gets its own timeout budget; when the caller signal fires,
 * the fetch aborts immediately.
 */
export function mergeWithTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}
