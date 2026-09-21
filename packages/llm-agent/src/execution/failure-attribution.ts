import type { LlmAttemptBudget } from './attempt-budget';

export type LlmExecutionFailureKind =
  | 'provider'
  | 'caller_cancellation'
  | 'non_provider';

export type LlmExecutionFailureTracker = {
  run<T>(providerCall: () => Promise<T>): Promise<T>;
  resetForRetry(): void;
  classify(): LlmExecutionFailureKind;
};

interface LlmExecutionFailureTrackerOptions {
  callerSignal?: AbortSignal;
  deadlineSignal: AbortSignal;
  attemptBudget?: LlmAttemptBudget;
}

/**
 * Keeps abort provenance at the execution boundary. Error names are not
 * reliable here because providers may wrap AbortError/TimeoutError.
 */
export function createLlmExecutionFailureTracker({
  callerSignal,
  deadlineSignal,
  attemptBudget,
}: LlmExecutionFailureTrackerOptions): LlmExecutionFailureTracker {
  let providerFailure = false;
  let deadlineExpiredDuringProvider = false;
  let providerAttemptInFlight = false;

  return {
    async run<T>(providerCall: () => Promise<T>): Promise<T> {
      if (deadlineSignal.aborted) {
        throw deadlineSignal.reason ?? new Error('Execution deadline exceeded');
      }

      const onDeadline = (): void => {
        if (providerAttemptInFlight) {
          deadlineExpiredDuringProvider = true;
        }
      };
      const onProviderAttempt = (inFlight: boolean): void => {
        providerAttemptInFlight = inFlight;
      };
      providerAttemptInFlight = true;
      deadlineSignal.addEventListener('abort', onDeadline, { once: true });
      const removeProviderAttemptObserver =
        attemptBudget?.observeProviderAttempt(onProviderAttempt);
      try {
        return await providerCall();
      } catch (error) {
        providerFailure = true;
        throw error;
      } finally {
        providerAttemptInFlight = false;
        removeProviderAttemptObserver?.();
        deadlineSignal.removeEventListener('abort', onDeadline);
      }
    },

    resetForRetry(): void {
      providerFailure = false;
      deadlineExpiredDuringProvider = false;
    },

    classify(): LlmExecutionFailureKind {
      if (callerSignal?.aborted) {
        return 'caller_cancellation';
      }
      if (providerFailure) {
        return 'provider';
      }
      // A global deadline is provider-attributed only when its abort raced an
      // in-flight provider call; admission, Redis, and backoff expiry stay
      // outside provider-circuit accounting.
      if (deadlineSignal.aborted && !deadlineExpiredDuringProvider) {
        return 'non_provider';
      }
      if (deadlineExpiredDuringProvider) {
        return 'provider';
      }
      return 'non_provider';
    },
  };
}
