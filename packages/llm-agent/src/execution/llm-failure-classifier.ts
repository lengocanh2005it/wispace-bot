import { isAbortError } from '@wispace/bot-common/utils';
import { LlmAllProvidersExhaustedError } from '../provider/failover/failover.errors';
import { LlmProviderCircuitOpenError } from './circuit-error';
import { LlmOverloadError } from './bounded-admission';
import type { LlmDegradedFailureClass } from '../ports';

/**
 * Maps an LLM execution error to a bounded failure class enum.
 *
 * Rules (#549, #1380):
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
  if (isAbortError(error)) {
    return 'timeout';
  }
  return 'unknown';
}
