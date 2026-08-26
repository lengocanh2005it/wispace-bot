import { maskExternalId } from '@wispace/bot-common/masking';

/** Thrown by `CapacityDataPort` when the platform has no scored Writing tasks yet. */
export class StudentReportNoScoreDataError extends Error {
  constructor(externalUserId: string) {
    super(
      `No TaskScoreAverage data for externalUserId=${maskExternalId(
        externalUserId,
      )}`,
    );
    this.name = 'StudentReportNoScoreDataError';
  }
}

/** Structural shape of a retryable upstream API error (e.g. Wispace 5xx). */
export interface RetryableApiError extends Error {
  statusCode: number;
  endpoint: string;
  isRetryable(): boolean;
}

/** Thrown when the upstream API failed with a retryable (5xx) status. */
export class StudentReportRetryableError extends Error {
  constructor(
    readonly externalUserId: string,
    readonly cause: RetryableApiError,
  ) {
    super(cause.message);
    this.name = 'StudentReportRetryableError';
  }
}
