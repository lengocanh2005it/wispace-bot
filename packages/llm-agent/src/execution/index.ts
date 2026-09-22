// LLM execution infrastructure — admission, config, redis
export {
  BoundedAdmissionQueue,
  LlmOverloadError,
  raceAbort,
  INTERACTIVE_LLM_FEATURES,
  admissionWaitBudgetMs,
} from './bounded-admission';
export type { AdmissionTicket, LlmOverloadReason } from './bounded-admission';
export {
  createEnvLlmExecutionPort,
  createLlmAdmissionCoordinator,
} from './env-llm-execution.port';
export type {
  AdmissionMetrics,
  EnvLlmExecutionConfig,
  LlmAdmissionRedisSource,
} from './env-llm-execution.port';
export { LlmAdmissionCoordinator } from './llm-admission-coordinator';
export type {
  LlmAdmissionGlobalMetrics,
  LlmAdmissionGlobalPort,
  LlmAdmissionCoordinatorConfig,
  LlmAdmissionLease,
} from './llm-admission-coordinator';
export { buildLlmExecutionConfig } from './llm-execution.config';
export type { LlmExecutionConfigReader } from './llm-execution.config';
export {
  DEFAULT_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS,
  MAX_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS,
  LlmAttemptBudget,
  normalizeMaxTotalProviderAttempts,
  readMaxTotalProviderAttempts,
} from './attempt-budget';
export { acquireRedisSlot } from './redis-slot-limiter';
export {
  calculateBackgroundAdmissionCapacity,
  resolveBackgroundProducerConcurrency,
} from './background-admission-capacity';
export type {
  BackgroundAdmissionCapacityConfig,
  BackgroundProducerConcurrencyOptions,
} from './background-admission-capacity';
export {
  LlmProviderCircuitOpenError,
  type LlmProviderCircuitState,
} from './circuit-error';
export {
  createLlmExecutionFailureTracker,
  type LlmExecutionFailureClass,
  type LlmExecutionFailureClassification,
  type LlmExecutionFailureKind,
  type LlmExecutionFailureTracker,
} from './failure-attribution';
