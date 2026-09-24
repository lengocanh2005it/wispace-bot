// ---------------------------------------------------------------------------
// Compatibility façade: preserve the historical root surface while new code
// selects the explicit `/core` or `/adapters` entrypoint.
// ---------------------------------------------------------------------------

// Core agent
export {
  DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
  LlmAgentService,
  LlmRetryExhaustedError,
  classifyLlmFailure,
} from './agent.service';
export type { LlmAgentPorts } from './agent.service';
export {
  CHAT_SYSTEM_PROMPT_CORE,
  composeChatSystemPrompt,
  generatePromptCanary,
} from './chat-system-prompt';

// Core types
export type {
  ChatHistoryMessage,
  LlmAgentConfig,
  LlmAgentInput,
  LlmAgentPromptParts,
  LlmAgentReply,
} from './types';

// Core provider
export type { LlmProviderAdapter } from './provider/llm-provider.adapter';
export { createLlmProviderAdapterFromEnv } from './provider/from-env.factory';

// Intent detection
export {
  IntentDetector,
  type IntentType,
  type IntentConfig,
  type IntentMatch,
} from './intent-detector';

// ---------------------------------------------------------------------------
// Sub-path re-exports (backward compatibility)
// Existing callers: `import { X } from '@wispace/llm-agent'` still works.
// New callers can use: `import { X } from '@wispace/llm-agent/<sub-path>'`
// ---------------------------------------------------------------------------

// Provider — adapters, factory, types
export {
  OpenAiAdapter,
  FailoverLlmProviderAdapter,
  LlmAllProvidersExhaustedError,
  createLlmProviderAdapter,
  createFailoverLlmProviderAdapter,
  createFailoverProviderEntries,
  assertSupportedLlmProvider,
} from './provider/index';
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
  LlmProviderEntryConfig,
  FailoverConfig,
  FailoverCircuitEvent,
  FailoverProviderOutcome,
  LlmProviderPolicy,
  LlmProviderValidationInput,
} from './provider/index';
export {
  buildLlmProviderPolicyFromEnv,
  validateLlmProviderConfiguration,
  validateLlmProviderModel,
} from './provider/index';

// Tools — agent tool definitions and helpers
export {
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  SCORE_TOOLS,
  SCHEDULE_TOOLS,
  isAgentToolName,
  readPositiveLimit,
  readPastDays,
  readPositiveInteger,
  readValidatedDate,
  readValidatedTime,
  getAgentToolDefinition,
  parseAndValidateToolArguments,
  canonicalizeToolArguments,
  validateAgentToolRegistry,
  deriveAgentToolMap,
  getAgentToolNamesByGroundingClaim,
} from './agent.tools';
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
} from './agent.tools';

// Utils — safety, scope, retry, text, privacy
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
  buildPrecreateExerciseUnavailableMessage,
  buildWriteToolDailyBudgetMessage,
  buildWriteToolPerMessageBudgetMessage,
  detectPromptInjection,
  detectPromptInjectionAcrossTurns,
  detectDisclosureProbe,
  sanitizeToolResultContent,
  sanitizeUntrustedTextForLlm,
  redactSecrets,
  registerRuntimeSecrets,
  resetRuntimeSecretsForTests,
  collectRuntimeSecretValues,
  REDACTED_PLACEHOLDER,
  CREDENTIAL_SHAPES,
  checkLlmGrounding,
  isOpenAiRateLimitError,
  isOpenAiServerError,
  isObviouslyOffTopic,
  isGreetingOnly,
  isAmbiguousMessage,
  isStopIntent,
  normalizeScopeText,
  isDistressExpression,
  detectPrivacyIntent,
  isConfirmationResponse,
  isCancellationResponse,
  PrivacyStateService,
  sanitizeReplyText,
  sleep,
  retryWithBackoff,
  cappedExponentialBackoff,
  loadSystemPromptFile,
  canonicalizeToolObservation,
  fitToolObservation,
  observationMarker,
  projectToolObservation,
  reduceToolObservation,
} from './utils/index';
export type {
  InjectionCheckResult,
  DisclosureProbeResult,
  DisclosureProbeCategory,
  LlmGroundingResult,
  PrivacyAction,
  PrivacyIntent,
  ReducedToolObservation,
  ToolObservationOutcome,
} from './utils/index';

// Ports — DI tokens and port interfaces
export { NOOP_METRICS_PORT } from './ports';
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
} from './ports';

// Execution — admission, config, redis
export {
  BoundedAdmissionQueue,
  LlmOverloadError,
  LlmExecutionDisabledError,
  raceAbort,
  INTERACTIVE_LLM_FEATURES,
  admissionWaitBudgetMs,
  createEnvLlmExecutionPort,
  createLlmAdmissionCoordinator,
  LlmAdmissionCoordinator,
  buildLlmExecutionConfig,
  calculateBackgroundAdmissionCapacity,
  resolveBackgroundProducerConcurrency,
  LlmProviderCircuitOpenError,
  LlmAttemptBudget,
  DEFAULT_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS,
  MAX_LLM_MAX_TOTAL_PROVIDER_ATTEMPTS,
  normalizeMaxTotalProviderAttempts,
  readMaxTotalProviderAttempts,
} from './execution/index';
export type {
  AdmissionTicket,
  LlmOverloadReason,
  AdmissionMetrics,
  BackgroundAdmissionCapacityConfig,
  BackgroundProducerConcurrencyOptions,
  LlmExecutionConfigReader,
  EnvLlmExecutionConfig,
  LlmAdmissionRedisSource,
  LlmAdmissionGlobalMetrics,
  LlmAdmissionGlobalPort,
  LlmAdmissionCoordinatorConfig,
  LlmAdmissionLease,
  LlmProviderCircuitState,
} from './execution/index';

// Input classifier (#649) — port + prompt; implementation lives in @wispace/chat-agent
export { CLASSIFIER_SYSTEM_PROMPT } from './classifier/classifier-prompt';
export {
  CLASSIFIER_LABELS,
  CLASSIFIER_FAILURE_REASONS,
  CLASSIFIER_OUTCOME_LABELS,
  isExtractionReason,
  type ClassifierLabel,
  type ClassifierOutcomeLabel,
  type FlaggedClassifierLabel,
  type ClassifierVerdict,
  type ClassifyResult,
  type ClassifyFailureReason,
  type ContentClassifierPort,
} from './classifier/content-classifier.port';
