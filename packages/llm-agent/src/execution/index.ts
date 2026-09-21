// LLM execution infrastructure — admission, config, redis
export {
  BoundedAdmissionQueue,
  LlmOverloadError,
  raceAbort,
  INTERACTIVE_LLM_FEATURES,
  admissionWaitBudgetMs,
} from './bounded-admission';
export type { AdmissionTicket, LlmOverloadReason } from './bounded-admission';
export { createEnvLlmExecutionPort } from './env-llm-execution.port';
export type {
  AdmissionMetrics,
  EnvLlmExecutionConfig,
} from './env-llm-execution.port';
export { buildLlmExecutionConfig } from './llm-execution.config';
export {
  DEFAULT_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS,
  MAX_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS,
  LlmAttemptBudget,
  normalizeMaxTotalProviderAttempts,
  readMaxTotalProviderAttempts,
} from './attempt-budget';
export { acquireRedisSlot } from './redis-slot-limiter';
export {
  LlmProviderCircuitOpenError,
  type LlmProviderCircuitState,
} from './circuit-error';
export {
  createLlmExecutionFailureTracker,
  type LlmExecutionFailureKind,
  type LlmExecutionFailureTracker,
} from './failure-attribution';
