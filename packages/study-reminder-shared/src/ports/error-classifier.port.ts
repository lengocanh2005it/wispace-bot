/**
 * Optional port for classifying errors as terminal (no retry).
 * Messenger injects this to detect 24h window / Wispace non-retryable errors.
 * Discord/Zalo inject nothing — all errors are retryable.
 */
export const ERROR_CLASSIFIER = Symbol('ERROR_CLASSIFIER');

export interface ErrorClassifierPort {
  /** Returns true if the error should NOT be retried (mark job terminal immediately). */
  isTerminal(error: unknown): boolean;
}
