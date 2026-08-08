import { Logger } from '@nestjs/common';
import { maskExternalId } from '@wispace/bot-common';
import { isProactiveMessenger24hError } from '@messenger/modules/messenger/application/utils/proactive-send.utils';
import { WispaceApiError } from '@messenger/shared/errors/wispace-api.error';

/**
 * Messenger terminal-failure classification for study reminder dispatch.
 * Mirrors the former in-app StudyReminderDispatchService logic: the Meta 24h
 * window and non-retryable Wispace errors are terminal (no retry); the 24h
 * error message is normalized before persisting.
 */
export function classifyMessengerDispatchFailure(params: {
  error: unknown;
  externalUserId: string;
  jobId: number;
  retryCount: number;
  maxRetries: number;
}): { terminal: boolean; errorMessage: string } {
  const message =
    params.error instanceof Error ? params.error.message : String(params.error);
  const is24hWindow = isProactiveMessenger24hError(params.error);
  const isNonRetryableWispace =
    params.error instanceof WispaceApiError && !params.error.isRetryable();
  const retriesExhausted = params.retryCount + 1 >= params.maxRetries;
  const logger = new Logger('StudyReminderDispatch');

  if (is24hWindow) {
    logger.warn(
      `MESSENGER_24H_WINDOW psid=${maskExternalId(params.externalUserId)} jobId=${params.jobId} study_reminder`,
    );
  }

  if (isNonRetryableWispace) {
    logger.warn(
      `WISPACE_NON_RETRYABLE psid=${maskExternalId(params.externalUserId)} jobId=${params.jobId} status=${(params.error as WispaceApiError).statusCode}; marking terminal`,
    );
  }

  return {
    terminal: is24hWindow || isNonRetryableWispace || retriesExhausted,
    errorMessage: is24hWindow
      ? 'Messenger 24h messaging window closed'
      : message,
  };
}
