import { Logger } from '@nestjs/common';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { WispaceApiError } from '@wispace/wispace-client/core';
import { isMessenger24hWindowError } from '../contracts/messenger-delivery.contract';

/** Messenger-owned terminal/retry classification for study-reminder sends. */
export function classifyMessengerDispatchFailure(params: {
  error: unknown;
  externalUserId: string;
  jobId: number;
  retryCount: number;
  maxRetries: number;
}): { terminal: boolean; errorMessage: string } {
  const message = errorMessage(params.error, params.externalUserId);
  const is24hWindow = isMessenger24hWindowError(params.error);
  const wispaceError =
    params.error instanceof WispaceApiError ? params.error : undefined;
  const isNonRetryableWispace =
    wispaceError !== undefined && !wispaceError.isRetryable();
  const retriesExhausted = params.retryCount + 1 >= params.maxRetries;
  const logger = new Logger('StudyReminderDispatch');

  if (is24hWindow) {
    logger.warn(
      `MESSENGER_24H_WINDOW psid=${maskExternalId(params.externalUserId)} jobId=${params.jobId} study_reminder`,
    );
  }

  if (isNonRetryableWispace) {
    logger.warn(
      `WISPACE_NON_RETRYABLE psid=${maskExternalId(params.externalUserId)} jobId=${params.jobId} status=${wispaceError.statusCode}; marking terminal`,
    );
  }

  return {
    terminal: is24hWindow || isNonRetryableWispace || retriesExhausted,
    errorMessage: is24hWindow
      ? 'Messenger 24h messaging window closed'
      : message,
  };
}
