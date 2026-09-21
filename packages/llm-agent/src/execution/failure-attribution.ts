import type { LlmAttemptBudget } from './attempt-budget';
import { LlmAllProvidersExhaustedError } from '../provider/failover/failover.errors';
import type { LlmProviderAdapter } from '../provider/llm-provider.adapter';
import type { LlmProviderError } from '../provider/types';

export type LlmExecutionFailureKind =
  | 'provider'
  | 'caller_cancellation'
  | 'non_provider';

export type LlmExecutionFailureClass =
  | LlmProviderError['reason']
  | 'caller_cancellation'
  | 'non_provider';

export interface LlmExecutionFailureClassification {
  kind: LlmExecutionFailureKind;
  errorClass: LlmExecutionFailureClass;
  countsForCircuit: boolean;
}

export type LlmExecutionFailureTracker = {
  run<T>(providerCall: () => Promise<T>): Promise<T>;
  resetForRetry(): void;
  classify(
    error: unknown,
    adapter: LlmProviderAdapter,
  ): LlmExecutionFailureClassification;
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

    classify(
      error: unknown,
      adapter: LlmProviderAdapter,
    ): LlmExecutionFailureClassification {
      if (callerSignal?.aborted) {
        return {
          kind: 'caller_cancellation',
          errorClass: 'caller_cancellation',
          countsForCircuit: false,
        };
      }
      if (providerFailure) {
        return classifyProviderFailure(error, adapter);
      }
      // A global deadline is provider-attributed only when its abort raced an
      // in-flight provider call; admission, Redis, and backoff expiry stay
      // outside provider-circuit accounting.
      if (deadlineSignal.aborted && !deadlineExpiredDuringProvider) {
        return {
          kind: 'non_provider',
          errorClass: 'non_provider',
          countsForCircuit: false,
        };
      }
      if (deadlineExpiredDuringProvider) {
        return classifyProviderFailure(error, adapter);
      }
      return {
        kind: 'non_provider',
        errorClass: 'non_provider',
        countsForCircuit: false,
      };
    },
  };
}

const PROVIDER_ERROR_REASONS: ReadonlySet<LlmProviderError['reason']> = new Set(
  [
    'rate_limit',
    'timeout',
    'server_error',
    'network',
    'auth',
    'bad_request',
    'quota_exceeded',
    'unknown',
  ],
);

function normalizeProviderReason(reason: unknown): LlmProviderError['reason'] {
  return isProviderErrorReason(reason) ? reason : 'unknown';
}

function isProviderErrorReason(
  reason: unknown,
): reason is LlmProviderError['reason'] {
  return (
    typeof reason === 'string' &&
    PROVIDER_ERROR_REASONS.has(reason as LlmProviderError['reason'])
  );
}

function isNormalizedProviderError(error: unknown): error is LlmProviderError {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return (
    typeof candidate['provider'] === 'string' &&
    isProviderErrorReason(candidate['reason'])
  );
}

function getProviderFailureReasons(
  error: unknown,
  adapter: LlmProviderAdapter,
): LlmProviderError['reason'][] {
  if (
    error instanceof LlmAllProvidersExhaustedError &&
    error.failureReasons.length > 0
  ) {
    return error.failureReasons.map(normalizeProviderReason);
  }
  if (isNormalizedProviderError(error)) return [error.reason];

  try {
    return [normalizeProviderReason(adapter.normalizeError?.(error)?.reason)];
  } catch {
    return ['unknown'];
  }
}

function classifyProviderFailure(
  error: unknown,
  adapter: LlmProviderAdapter,
): LlmExecutionFailureClassification {
  const reasons = getProviderFailureReasons(error, adapter);
  const healthReason = reasons.find((reason) => reason !== 'bad_request');
  return {
    kind: 'provider',
    errorClass: healthReason ?? 'bad_request',
    countsForCircuit: healthReason !== undefined,
  };
}
