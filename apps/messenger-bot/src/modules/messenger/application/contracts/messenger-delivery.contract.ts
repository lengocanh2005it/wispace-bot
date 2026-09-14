/** Neutral application contract for Messenger delivery errors and outcomes. */
export class MessengerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly responseBody: string,
  ) {
    super(message);
    this.name = 'MessengerApiError';
  }

  isTokenExpired(): boolean {
    return (
      this.status === 400 &&
      (this.responseBody.includes('"code":190') ||
        this.responseBody.includes('"code": 190') ||
        this.responseBody.includes('OAuthException'))
    );
  }
}

export function isMessengerAmbiguousDeliveryError(error: unknown): boolean {
  return error instanceof MessengerApiError && error.status === 408;
}

/** H4: at least one bubble was delivered before a later Send API failure. */
export class MessengerPartialSendError extends MessengerApiError {
  constructor(
    readonly bubblesSent: number,
    cause: MessengerApiError,
  ) {
    super(cause.message, cause.status, cause.statusText, cause.responseBody);
    this.name = 'MessengerPartialSendError';
  }
}

/** Meta subcode for mark_seen / typing_on / react failures — not the 24h window. */
const MESSENGER_SENDER_ACTION_FAILED_SUBCODE = 2018048;

/** Meta subcode for messaging outside the standard 24-hour window. */
const MESSENGER_OUTSIDE_WINDOW_SUBCODE = 2018278;

const MESSAGING_WINDOW_TEXT_MARKERS = [
  'outside of the allowed window',
  'outside the allowed window',
  '24 hour',
  '24-hour',
  'messaging window',
] as const;

function parseMetaGraphError(responseBody: string): {
  code?: number;
  errorSubcode?: number;
  message?: string;
} | null {
  try {
    const parsed = JSON.parse(responseBody) as {
      error?: { code?: unknown; error_subcode?: unknown; message?: unknown };
    };
    const err = parsed.error;
    if (!err || typeof err !== 'object') {
      return null;
    }

    return {
      code: typeof err.code === 'number' ? err.code : undefined,
      errorSubcode:
        typeof err.error_subcode === 'number' ? err.error_subcode : undefined,
      message: typeof err.message === 'string' ? err.message : undefined,
    };
  } catch {
    return null;
  }
}

export function isMessengerSenderActionError(error: unknown): boolean {
  if (!(error instanceof MessengerApiError)) {
    return false;
  }

  const meta = parseMetaGraphError(error.responseBody);
  return meta?.errorSubcode === MESSENGER_SENDER_ACTION_FAILED_SUBCODE;
}

export function isMessenger24hWindowError(error: unknown): boolean {
  if (!(error instanceof MessengerApiError)) {
    return false;
  }

  if (isMessengerSenderActionError(error)) {
    return false;
  }

  const meta = parseMetaGraphError(error.responseBody);
  if (meta?.errorSubcode === MESSENGER_OUTSIDE_WINDOW_SUBCODE) {
    return true;
  }
  if (meta?.code === 10) {
    return true;
  }

  const haystack =
    `${error.message} ${meta?.message ?? ''} ${error.responseBody}`.toLowerCase();
  return MESSAGING_WINDOW_TEXT_MARKERS.some((marker) =>
    haystack.includes(marker.toLowerCase()),
  );
}
