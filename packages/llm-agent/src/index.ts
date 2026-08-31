// ---------------------------------------------------------------------------
// Root exports — core symbols only
// Sub-path exports: @wispace/llm-agent/{provider,tools,utils,execution}
// ---------------------------------------------------------------------------

// Core agent
export { LlmAgentService, LlmRetryExhaustedError } from './agent.service';
export type { LlmAgentPorts } from './agent.service';
export {
  CHAT_SYSTEM_PROMPT_CORE,
  composeChatSystemPrompt,
} from './chat-system-prompt';

// Core types
export type {
  ChatHistoryMessage,
  LlmAgentConfig,
  LlmAgentInput,
  LlmAgentReply,
  LlmAgentStreamEvent,
  LlmAgentExecuteCallbacks,
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
  LlmStreamEvent,
  LlmProviderError,
  LlmProviderEntryConfig,
  FailoverConfig,
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
  readCalendarTimeRange,
  readPositiveInteger,
  readSchedulingMode,
  readValidatedDate,
  readValidatedTime,
  getAgentToolDefinition,
  parseAndValidateToolArguments,
  canonicalizeToolArguments,
  validateAgentToolRegistry,
} from './agent.tools';
export type {
  AgentToolName,
  AgentToolCapability,
  AgentToolDefinition,
  ToolEffect,
  ToolIdentityRequirement,
  ToolAuthorizationRequirement,
  ToolConfirmationRequirement,
  ToolIdempotencyStrategy,
  ToolArgumentValidationResult,
} from './agent.tools';

// Utils — safety, scope, retry, text, privacy
export {
  CHAT_FAILURE_FALLBACK_MESSAGE,
  NON_DISCLOSURE_REPLY,
  buildPromptInjectionBlockedMessage,
  buildNonDisclosureReply,
  buildWispaceScopeRedirectMessage,
  buildClarificationMessage,
  buildClarificationCancelledMessage,
  buildClarificationUnavailableMessage,
  buildGroundingBlockedMessage,
  buildPrecreateExerciseUnavailableMessage,
  detectPromptInjection,
  detectDisclosureProbe,
  sanitizeToolResultContent,
  sanitizeUntrustedTextForLlm,
  checkLlmGrounding,
  isOpenAiRateLimitError,
  isOpenAiServerError,
  isObviouslyOffTopic,
  isGreetingOnly,
  isAmbiguousMessage,
  normalizeScopeText,
  detectPrivacyIntent,
  isConfirmationResponse,
  isCancellationResponse,
  PrivacyStateService,
  sanitizeReplyText,
  sleep,
  retryWithBackoff,
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
  LlmRoundOutcome,
  LlmSafetyEventPort,
  LlmUsageRecorderPort,
  ToolExecutorPort,
} from './ports';

// Execution — admission, config, redis
export {
  BoundedAdmissionQueue,
  LlmOverloadError,
  raceAbort,
  INTERACTIVE_LLM_FEATURES,
  admissionWaitBudgetMs,
  createEnvLlmExecutionPort,
  buildLlmExecutionConfig,
  acquireRedisSlot,
  LlmProviderCircuitOpenError,
} from './execution/index';
export type {
  AdmissionTicket,
  LlmOverloadReason,
  AdmissionMetrics,
  EnvLlmExecutionConfig,
  LlmProviderCircuitState,
} from './execution/index';
