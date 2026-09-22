import { isAbortError } from '@wispace/bot-common/utils';
import { LlmAllProvidersExhaustedError } from '../provider/failover/failover.errors';
import { LlmProviderCircuitOpenError } from './circuit-error';
import { LlmOverloadError } from './bounded-admission';
import type { LlmDegradedFailureClass } from '../ports';

export class LlmRetryExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    cause: unknown,
  ) {
    super(`LLM call failed after ${attempts} attempts`);
    this.name = 'LlmRetryExhaustedError';
    this.cause = cause;
  }
}

/**
 * Maps an LLM execution error to a bounded failure class enum.
 *
 * Rules (#549, #1380):
 * - Unwraps `LlmRetryExhaustedError` so retry exhaustion preserves the root cause.
 * - Returns ONLY a member of `LlmDegradedFailureClass` — never raw error text or stack traces.
 * - Used across Chat, Student Report, and Study Reminder for zero-token failure rows.
 */
export function classifyLlmFailure(error: unknown): LlmDegradedFailureClass {
  if (error instanceof LlmAllProvidersExhaustedError) {
    return 'provider_exhausted';
  }
  if (error instanceof LlmProviderCircuitOpenError) {
    return 'provider_circuit_open';
  }
  if (error instanceof LlmOverloadError) {
    return 'execution_overload';
  }
  if (error instanceof LlmRetryExhaustedError) {
    return error.cause instanceof Error
      ? classifyLlmFailure(error.cause)
      : 'unknown';
  }
  if (isAbortError(error)) {
    return 'timeout';
  }
  return 'unknown';
}
