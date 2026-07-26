export { LlmAgentService, LlmRetryExhaustedError } from './agent.service';
export type { LlmAgentPorts } from './agent.service';
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
  readOptionalString,
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
  buildPromptInjectionBlockedMessage,
  buildWispaceScopeRedirectMessage,
  buildGroundingBlockedMessage,
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
  isOpenAiRetryableError,
  isOpenAiServerError,
} from './utils/openai-error.utils';
export { isObviouslyOffTopic, isGreetingOnly } from './utils/scope.utils';
export { sanitizeReplyText } from './utils/text.utils';
export { loadSystemPromptFile } from './utils/load-system-prompt';

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
export { OpenRouterAdapter } from './provider/openrouter/openrouter-adapter';
export { MiniMaxAdapter } from './provider/minimax/minimax-adapter';
export { FailoverLlmProviderAdapter } from './provider/failover/failover-adapter';
export { LlmAllProvidersExhaustedError } from './provider/failover/failover.errors';
export {
  createLlmProviderAdapter,
  createFailoverLlmProviderAdapter,
} from './provider/factory';
export type {
  LlmProviderEntryConfig,
  FailoverConfig,
} from './provider/factory';

// --- Tool result cache ---
export type {
  ToolResultCachePort,
  AsyncToolResultCachePort,
} from './tool-cache/tool-result-cache.port';
export { NOOP_TOOL_RESULT_CACHE } from './tool-cache/tool-result-cache.port';
export { InMemoryToolResultCache } from './tool-cache/in-memory-tool-result-cache';
export {
  RedisToolResultCache,
  type RedisCacheClient,
} from './tool-cache/redis-tool-result-cache';
