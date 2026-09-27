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
