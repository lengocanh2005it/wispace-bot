// Framework-free LLM orchestration, contracts, policies, and provider ports.
// Keep runtime factories, SDK adapters, Redis admission, and privacy state in
// `@wispace/llm-agent/adapters`.

export {
  LlmAgentService,
  LlmRetryExhaustedError,
  classifyLlmFailure,
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
} from '../utils/prompt-injection.utils';
export type {
  InjectionCheckResult,
  DisclosureProbeResult,
  DisclosureProbeCategory,
} from '../utils/prompt-injection.utils';
export { checkLlmGrounding } from '../utils/llm-grounding.utils';
export type { LlmGroundingResult } from '../utils/llm-grounding.utils';
export {
  isOpenAiRateLimitError,
  isOpenAiServerError,
} from '../utils/openai-error.utils';
export {
  isObviouslyOffTopic,
  isGreetingOnly,
  isAmbiguousMessage,
  isStopIntent,
  normalizeScopeText,
  isDistressExpression,
} from '../utils/scope.utils';
export {
  detectPrivacyIntent,
  isConfirmationResponse,
  isCancellationResponse,
  type PrivacyAction,
  type PrivacyIntent,
} from '../utils/privacy-intent.utils';
export { sanitizeReplyText } from '../utils/text.utils';
export {
  sleep,
  retryWithBackoff,
  cappedExponentialBackoff,
} from '../utils/retry.utils';
export { loadSystemPromptFile } from '../utils/load-system-prompt';
export {
  canonicalizeToolObservation,
  fitToolObservation,
  observationMarker,
  projectToolObservation,
  reduceToolObservation,
} from '../utils/tool-observation';
export type {
  ReducedToolObservation,
  ToolObservationOutcome,
} from '../utils/tool-observation';
export {
  SYSTEM_PROMPT_LEAK_MARKERS,
  checkFinalOutputSafety,
  checkPromptCanarySafety,
  isHarmfulOutputSafetyReason,
} from '../utils/final-output.utils';
export type {
  FinalOutputSafetyResult,
  HarmfulOutputSafetyReason,
} from '../utils/final-output.utils';
export {
  CREDENTIAL_SHAPES,
  findCredentialShape,
} from '../utils/secret-patterns.utils';
export {
  collectRuntimeSecretValues,
  redactSecrets,
  registerRuntimeSecrets,
  resetRuntimeSecretsForTests,
  REDACTED_PLACEHOLDER,
} from '../utils/secret-redaction.utils';

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
  isExtractionReason,
  type ClassifierLabel,
  type FlaggedClassifierLabel,
  type ClassifierVerdict,
  type ClassifyResult,
  type ClassifyFailureReason,
  type ContentClassifierPort,
} from '../classifier/content-classifier.port';
