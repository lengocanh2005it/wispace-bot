/**
 * Attributes a thrown error to its origin, so the two failure kinds this codebase
 * already names are not confused for one another.
 *
 * `isPlatformApiError` recognises a delivery failure classification — the
 * platform-owned interpretation of an outbound delivery failure, distinct from a
 * provider's `OutboundDeliveryOutcome`. The other two recognise an upstream-health
 * signal for this vendor specifically: a rate limit or a server error, which
 * accumulate toward the execution circuit.
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

export function isOpenAiRateLimitError(error: unknown): boolean {
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

export function isOpenAiServerError(error: unknown): boolean {
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
