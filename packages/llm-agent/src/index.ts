// LLM Agent package exports
export { LlmAgentService, LlmRetryExhaustedError } from './agent.service';
export type { LlmAgentPorts } from './agent.service';
export { CHAT_SYSTEM_PROMPT_CORE } from './chat-system-prompt';
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
} from './agent.tools';
export type { AgentToolName } from './agent.tools';
export { NOOP_METRICS_PORT } from './ports';
export type {
  AgentMetricsPort,
  LlmExecutionPort,
  LlmRoundOutcome,
  LlmSafetyEventPort,
  LlmUsageRecorderPort,
  ToolExecutorPort,
} from './ports';
export type {
  ChatHistoryMessage,
  LlmAgentConfig,
  LlmAgentInput,
  LlmAgentReply,
  LlmAgentStreamEvent,
  LlmAgentExecuteCallbacks,
} from './types';
export {
  CHAT_FAILURE_FALLBACK_MESSAGE,
  buildPromptInjectionBlockedMessage,
  buildWispaceScopeRedirectMessage,
  buildGroundingBlockedMessage,
  buildPrecreateExerciseUnavailableMessage,
} from './messages';
export {
  detectPromptInjection,
  sanitizeToolResultContent,
  sanitizeUntrustedTextForLlm,
} from './utils/prompt-injection.utils';
export type { InjectionCheckResult } from './utils/prompt-injection.utils';
export { checkLlmGrounding } from './utils/llm-grounding.utils';
export type { LlmGroundingResult } from './utils/llm-grounding.utils';
export {
  isOpenAiRateLimitError,
  isOpenAiServerError,
} from './utils/openai-error.utils';
export { isObviouslyOffTopic, isGreetingOnly } from './utils/scope.utils';
export {
  detectPrivacyIntent,
  isConfirmationResponse,
  isCancellationResponse,
  type PrivacyIntent,
} from './utils/privacy-intent.utils';
export { PrivacyStateService } from './utils/privacy-state.service';
export { sanitizeReplyText } from './utils/text.utils';
export { sleep, retryWithBackoff } from './utils/retry.utils';
export { loadSystemPromptFile } from './utils/load-system-prompt';
export { createEnvLlmExecutionPort } from './execution/env-llm-execution.port';
export type { EnvLlmExecutionConfig } from './execution/env-llm-execution.port';
export { acquireRedisSlot } from './execution/redis-slot-limiter';
export {
  IntentDetector,
  type IntentType,
  type IntentConfig,
  type IntentMatch,
} from './intent-detector';

// --- Provider abstraction (new) ---
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
} from './provider/types';
export type { LlmProviderAdapter } from './provider/llm-provider.adapter';
export { OpenAiAdapter } from './provider/openai/openai-adapter';
export { OpenAiCompatibleAdapter } from './provider/openai-compatible/openai-compatible-adapter';
export { FailoverLlmProviderAdapter } from './provider/failover/failover-adapter';
export { LlmAllProvidersExhaustedError } from './provider/failover/failover.errors';
export {
  createLlmProviderAdapter,
  createFailoverLlmProviderAdapter,
  createFailoverProviderEntries,
} from './provider/factory';
export { createLlmProviderAdapterFromEnv } from './provider/from-env.factory';
export type {
  LlmProviderEntryConfig,
  FailoverConfig,
} from './provider/factory';
