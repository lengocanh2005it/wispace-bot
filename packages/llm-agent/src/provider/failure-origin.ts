/**
 * Attributes a thrown error to its origin, so the two failure kinds this codebase
 * already names are not confused for one another.
 *
 * `isPlatformApiError` recognises a delivery failure classification — the
 * platform-owned interpretation of an outbound delivery failure, distinct from a
 * provider's `OutboundDeliveryOutcome`. The other two recognise an upstream-health
 * signal: a rate limit or a server error, which accumulate toward the execution
 * circuit. Their published names are vendor-neutral (#1438) but their bodies are
 * not: the checks still recognise one vendor's error shape, so a neutral name
 * describes the *capability* ("is this a rate limit?") without claiming the
 * classification itself is vendor-independent. The body is left unchanged
 * deliberately — rewriting it to plain HTTP status codes would change which
 * production errors reach which delivery message.
 *
 * The platform check is not a special case bolted on. It is the negative guard
 * that stops a platform error being misread as a provider one, which is why it
 * runs first in both classifiers.
 */
export function isPlatformApiError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'MessengerApiError' ||
      error.name === 'DiscordApiError' ||
      error.name === 'ZaloApiError')
  );
}

export function isRateLimitError(error: unknown): boolean {
  if (isPlatformApiError(error)) {
    return false;
  }
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const e = error as Record<string, unknown>;
  if (e['name'] === 'RateLimitError') {
    return true;
  }
  if (
    e['status'] === 429 &&
    typeof e['message'] === 'string' &&
    /openai|rate.?limit/i.test(e['message'])
  ) {
    return true;
  }
  return false;
}

export function isServerError(error: unknown): boolean {
  if (isPlatformApiError(error)) {
    return false;
  }
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const e = error as Record<string, unknown>;
  if (
    e['name'] === 'InternalServerError' ||
    e['name'] === 'APIConnectionError'
  ) {
    return true;
  }
  const status = e['status'];
  return typeof status === 'number' && status >= 500 && status < 600;
}
