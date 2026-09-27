// Framework-free LLM orchestration, contracts, policies, and provider ports.
// Keep runtime factories, SDK adapters, and Redis admission in adapters.

export {
  LlmAgentService,
  LlmRetryExhaustedError,
  classifyLlmFailure,
  DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
} from '../agent.service';
export type { LlmAgentPorts } from '../agent.service';
export {
  IntentDetector,
  type IntentType,
  type IntentConfig,
  type IntentMatch,
} from '../intent-detector';
export {
  CHAT_SYSTEM_PROMPT_CORE,
  composeChatSystemPrompt,
  generatePromptCanary,
} from '../chat-system-prompt';
export type {
  ChatHistoryMessage,
  LlmAgentConfig,
  LlmAgentInput,
  LlmAgentPromptParts,
  LlmAgentReply,
} from '../types';

export {
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  SCORE_TOOLS,
  SCHEDULE_TOOLS,
  isAgentToolName,
  readPositiveLimit,
  readPastDays,
  readPositiveInteger,
  buildBoundedToolResultMetadata,
  readValidatedDate,
  readValidatedTime,
  getAgentToolDefinition,
  parseAndValidateToolArguments,
  canonicalizeToolArguments,
  validateAgentToolRegistry,
  deriveAgentToolMap,
  getAgentToolNamesByGroundingClaim,
} from '../agent.tools';
export type {
  AgentToolName,
  AgentToolMap,
  AgentToolNameByBudget,
  AgentToolCapability,
  AgentToolMetadata,
  AgentToolDefinition,
  GetUpcomingStudySessionsArgs,
  ListStudyCalendarEntriesArgs,
  RescheduleStudySessionArgs,
  ToolEffect,
  ToolIdentityRequirement,
  ToolAuthorizationRequirement,
  ToolConfirmationRequirement,
  ToolIdempotencyStrategy,
  AgentToolGroundingClaim,
  AgentToolBudgetClassification,
  ToolArgumentValidationResult,
  BoundedToolResultMetadata,
  CalendarTimeRange,
  ToolResultCompleteness,
  BoundedToolDisclosure,
} from '../agent.tools';

export type { LlmProviderAdapter } from '../provider/llm-provider.adapter';
export { LlmAllProvidersExhaustedError } from '../provider/failover/failover.errors';
export type {
  LlmProvider,
  LlmFeature,
  LlmToolDefinition,
  LlmMessageRole,
  LlmToolCall,
  LlmMessage,
  LlmUsage,
  LlmProviderMetadata,
  LlmJsonRequest,
  LlmJsonResponse,
  LlmToolChatRequest,
  LlmToolChatResponse,
  LlmProviderError,
} from '../provider/types';

export {
  CHAT_FAILURE_FALLBACK_MESSAGE,
  NON_DISCLOSURE_REPLY,
  buildPromptInjectionBlockedMessage,
  buildHostilityDeflectionMessage,
  CRISIS_SUPPORT_RESOURCE_MESSAGE,
  buildCrisisSupportHandoffMessage,
  buildNonDisclosureReply,
  buildWispaceScopeRedirectMessage,
  buildClarificationMessage,
  buildClarificationCancelledMessage,
  buildStopAcknowledgedMessage,
  buildClarificationUnavailableMessage,
  buildGroundingBlockedMessage,
  buildCappedResultMessage,
  buildPrecreateExerciseUnavailableMessage,
  buildWriteToolDailyBudgetMessage,
  buildWriteToolPerMessageBudgetMessage,
} from '../messages';
export {
  detectPromptInjection,
  detectPromptInjectionAcrossTurns,
  detectDisclosureProbe,
  sanitizeToolResultContent,
  sanitizeUntrustedTextForLlm,
} from '../safety/prompt-injection.utils';
export type {
  InjectionCheckResult,
  DisclosureProbeResult,
  DisclosureProbeCategory,
} from '../safety/prompt-injection.utils';
export { checkLlmGrounding } from '../grounding/llm-grounding.utils';
export type { LlmGroundingResult } from '../grounding/llm-grounding.utils';
// Vendor-named on purpose for now: `chat-delivery.messages.ts` in messenger-bot
// branches on these to pick a delivery message, so getting the vendor out of
// this framework-free surface is a public rename with its own issue (#1438).
//
// The architecture guard does not flag this, for two separate reasons. It matches
// module specifiers, never exported symbol names, so it cannot see that these two
// names identify a vendor. And its outer-path list omits `provider`, so `core`
// importing from the provider tree is unconstrained — though it already did so
// for the provider types and the failover error before this module moved, so that
// import is not a new crossing. The first gap is what #1439 closes; the second is
// pre-existing. Do not read the naming as an accident to tidy up in passing.
export {
  isOpenAiRateLimitError,
  isOpenAiServerError,
} from '../provider/upstream-failure-classifiers';
export {
  isObviouslyOffTopic,
  isGreetingOnly,
  isAmbiguousMessage,
  isStopIntent,
  normalizeScopeText,
  isDistressExpression,
} from '../scope.utils';
export { sanitizeReplyText } from '../text.utils';
export {
  sleep,
  retryWithBackoff,
  cappedExponentialBackoff,
} from '../retry.utils';
export { loadSystemPromptFile } from '../load-system-prompt';
export {
  parseJsonObject,
  readRequiredStringField,
} from '../llm-json-output.utils';
export {
  canonicalizeToolObservation,
  fitToolObservation,
  observationMarker,
  projectToolObservation,
  reduceToolObservation,
} from '../observation/tool-observation';
export type {
  ReducedToolObservation,
  ToolObservationOutcome,
} from '../observation/tool-observation';
export {
  SYSTEM_PROMPT_LEAK_MARKERS,
  checkFinalOutputSafety,
  checkPromptCanarySafety,
  isHarmfulOutputSafetyReason,
} from '../safety/final-output.utils';
export type {
  FinalOutputSafetyResult,
  HarmfulOutputSafetyReason,
} from '../safety/final-output.utils';
export {
  CREDENTIAL_SHAPES,
  findCredentialShape,
} from '../safety/secret-patterns.utils';
export {
  collectRuntimeSecretValues,
  redactSecrets,
  registerRuntimeSecrets,
  resetRuntimeSecretsForTests,
  REDACTED_PLACEHOLDER,
} from '../safety/secret-redaction.utils';

export { NOOP_METRICS_PORT } from '../ports';
export type {
  AgentMetricsPort,
  LlmDegradedAction,
  LlmDegradedFailureClass,
  LlmDegradedModeEvent,
  LlmExecutionPort,
  LlmExecutionAttempt,
  LlmExecutionRetryCause,
  LlmExecutionMode,
  LlmRoundOutcome,
  LlmHarmfulOutputReason,
  LlmSafetyEventPort,
  LlmUsageRecorderPort,
  ToolExecutorPort,
} from '../ports';

export {
  BoundedAdmissionQueue,
  LlmOverloadError,
  LlmExecutionDisabledError,
  raceAbort,
  INTERACTIVE_LLM_FEATURES,
  admissionWaitBudgetMs,
} from '../execution/bounded-admission';
export { buildLlmExecutionConfig } from '../execution/llm-execution.config';
export type { LlmExecutionConfigReader } from '../execution/llm-execution.config';
export {
  calculateBackgroundAdmissionCapacity,
  resolveBackgroundProducerConcurrency,
} from '../execution/background-admission-capacity';
export type {
  BackgroundAdmissionCapacityConfig,
  BackgroundProducerConcurrencyOptions,
} from '../execution/background-admission-capacity';
export { createLlmExecutionFailureTracker } from '../execution/failure-attribution';
export type {
  LlmExecutionFailureClass,
  LlmExecutionFailureClassification,
  LlmExecutionFailureKind,
  LlmExecutionFailureTracker,
} from '../execution/failure-attribution';
export type {
  AdmissionTicket,
  LlmOverloadReason,
} from '../execution/bounded-admission';
export {
  LlmProviderCircuitOpenError,
  type LlmProviderCircuitState,
} from '../execution/circuit-error';
export {
  LlmAttemptBudget,
  DEFAULT_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS,
  MAX_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS,
  normalizeMaxTotalProviderAttempts,
  readMaxTotalProviderAttempts,
} from '../execution/attempt-budget';
export { LlmAdmissionCoordinator } from '../execution/llm-admission-coordinator';
export type {
  AdmissionMetrics,
  LlmAdmissionGlobalMetrics,
  LlmAdmissionGlobalPort,
  LlmAdmissionCoordinatorConfig,
  LlmAdmissionLease,
} from '../execution/llm-admission-coordinator';

export { CLASSIFIER_SYSTEM_PROMPT } from '../classifier/classifier-prompt';
export {
  CLASSIFIER_LABELS,
  CLASSIFIER_FAILURE_REASONS,
  CLASSIFIER_OUTCOME_LABELS,
  isExtractionReason,
  type ClassifierLabel,
  type FlaggedClassifierLabel,
  type ClassifierVerdict,
  type ClassifierOutcomeLabel,
  type ClassifyResult,
  type ClassifyFailureReason,
  type ContentClassifierPort,
} from '../classifier/content-classifier.port';
