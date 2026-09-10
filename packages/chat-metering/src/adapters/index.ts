// NestJS/TypeORM/Redis persistence and platform wiring for chat metering.

export {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  ChatToolDailyUsageEntity,
  LlmUsageEventEntity,
  LlmSafetyEventEntity,
} from '../entities';
export { ChatMeteringModule } from '../chat-metering.module';

export {
  ChatRateLimitRepository,
  type ChatRateLimitRepositoryHooks,
  type BurstCountRow,
} from '../chat-rate-limit/chat-rate-limit.repository';
export { PostgresBurstCounter } from '../chat-rate-limit/postgres-burst-counter';
export {
  RedisBurstCounter,
  CHAT_BURST_KEY_TTL_SECONDS,
  buildRedisBurstKey,
  buildLegacyRedisBurstKey,
  type RedisBurstCounterOptions,
} from '../chat-rate-limit/redis-burst-counter';
export {
  RedisBurstReconciler,
  type BurstReconciliationRepository,
  type RedisBurstReconciliationResult,
} from '../chat-rate-limit/redis-burst-reconciler';
export { PlatformChatRateLimitService } from '../chat-rate-limit/platform-chat-rate-limit.service';

export { LlmUsageRepository } from '../llm-usage/llm-usage.repository';
export { LlmUsageConfigService } from '../llm-usage/llm-usage-config.service';
export { PlatformLlmUsageRecorderAdapter } from '../llm-usage/platform-llm-usage-recorder.adapter';
export { provideWiredUsageRecorder } from '../llm-usage/platform-llm-usage-recorder.adapter';
export { LlmSafetyEventRepository } from '../llm-safety/llm-safety.repository';
export { PlatformLlmSafetyEventAdapter } from '../llm-safety/platform-llm-safety-event.adapter';
export { LlmSafetyCleanupService } from '../llm-safety/llm-safety-cleanup.service';
export { WriteToolBudgetRepository } from '../write-tool-budget/write-tool-budget.repository';
export { PlatformWriteToolBudgetService } from '../write-tool-budget/platform-write-tool-budget.service';
export { readWriteToolBudgetConfig } from '../write-tool-budget/write-tool-budget-config';
