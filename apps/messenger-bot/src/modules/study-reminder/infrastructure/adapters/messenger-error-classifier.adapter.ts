import type { ErrorClassifierPort } from '@wispace/study-reminder-shared';
import { shouldSkipProactiveRetries } from '@messenger/modules/messenger/application/utils/proactive-send.utils';
import { WispaceApiError } from '@messenger/shared/errors/wispace-api.error';

/**
 * Adapts Messenger's platform-specific error classification to the shared
 * ErrorClassifierPort. Detects Meta 24h window errors and non-retryable
 * Wispace API errors.
 */
export class MessengerErrorClassifierAdapter implements ErrorClassifierPort {
  isTerminal(error: unknown): boolean {
    if (shouldSkipProactiveRetries(error)) return true;
    if (error instanceof WispaceApiError && !error.isRetryable()) return true;
    return false;
  }
}
