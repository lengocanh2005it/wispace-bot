// Framework-free quota, usage, safety, and write-budget policies/contracts.
// TypeORM, Redis, NestJS modules, and platform wiring live in `adapters`.

export { todayInTimezone as todayUsageDate } from '@wispace/date-utils';

export { ChatRateLimitCore } from '../chat-rate-limit/chat-rate-limit-core.service';
export {
  MemoryBurstCounter,
  CHAT_BURST_WINDOW_MS,
} from '../chat-rate-limit/memory-burst-counter';
export type {
  BurstCounterPort,
  BurstReservationResult,
  ChatIdempotencyRecord,
  ChatQuotaCheckResult,
  ChatRateLimitRepositoryPort,
  ChatRateLimitSettings,
  LearnerUsageQuery,
  LearnerUsageQueryFactory,
  LearnerUsageQueryInput,
  ReserveFreeFormSlotInput,
  ReserveFreeFormSlotOutcome,
  ReserveIdempotencyInput,
  RecoverIdempotencyOutcome,
} from '../chat-rate-limit/types';
export type {
  ChatQuotaDenyReason,
  ChatQuotaReleaseReason,
  ChatIdempotencyStatus,
} from '../chat-quota.types';

export {
  buildInputCostEnvKey,
  buildOutputCostEnvKey,
  buildCachedInputCostEnvKey,
  buildProviderInputCostEnvKey,
  buildProviderOutputCostEnvKey,
  buildProviderCachedInputCostEnvKey,
  normalizeProviderForEnvKey,
  estimateCostUsd,
  addCostUsdStrings,
} from '../llm-usage/cost.utils';
export {
  LlmUsageRecorderCore,
  toUsageRecorderMetrics,
} from '../llm-usage/llm-usage-recorder-core.service';
export type {
  RecordLlmUsageFromCompletionInput,
  LlmUsageRecorderMetrics,
  BotMetricsUsageRecorderSource,
} from '../llm-usage/llm-usage-recorder-core.service';
export type {
  UsageWriterPort,
  LlmUsageAggregateRow,
  LlmUsageQueryFilter,
  RecordLlmUsageInput,
} from '../llm-usage/types';

export { LlmSafetyCore } from '../llm-safety/llm-safety-core.service';
export { redactSafetyText } from '../llm-safety/redact-safety-text';
export type {
  InsertLlmSafetyEvent,
  LlmSafetyEventRepositoryPort,
  RecordGroundingWarningInput,
  RecordInjectionEventInput,
  RecordClassifierVerdictInput,
  InjectionEventSource,
} from '../llm-safety/types';

export { WriteToolBudgetCore } from '../write-tool-budget/write-tool-budget-core.service';
export type {
  WriteToolBudgetSettings,
  WriteToolBudgetRepositoryPort,
  WriteToolBudgetDeniedReason,
  WriteToolBudgetConsumeResult,
} from '../write-tool-budget/write-tool-budget.types';
