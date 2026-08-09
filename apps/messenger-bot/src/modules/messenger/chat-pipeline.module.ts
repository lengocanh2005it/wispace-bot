import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { trace } from '@opentelemetry/api';
import { Repository } from 'typeorm';
import {
  PlatformAgentService,
  PlatformAgentToolsService,
  PlatformChatHistoryService,
} from '@wispace/chat-agent';
import {
  LlmSafetyEventEntity,
  LlmUsageEventEntity,
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
} from '@wispace/chat-metering';
import type { LlmProviderAdapter } from '@wispace/llm-agent';
import { sanitizeUntrustedTextForLlm } from '@wispace/llm-agent';
import { REDIS_CLIENT } from '@wispace/bot-common';
import { CommonModule } from '../../shared/common/common.module';
import { ChatRateLimitModule } from '../chat-rate-limit/chat-rate-limit.module';
import { LlmExecutionModule } from '../llm-execution/llm-execution.module';
import { LlmUsageModule } from '../llm-usage/llm-usage.module';
import { LlmUsageConfigService } from '../llm-usage/application/services/llm-usage-config.service';
import { StudentReportModule } from '../student-report/student-report.module';
import { StudyReminderModule } from '../study-reminder/study-reminder.module';
import { DisplayNameModule } from '../display-name/display-name.module';
import { UserDisplayNameService } from '../display-name/application/user-display-name.service';
import { MetricsService } from '../metrics/metrics.service';
import { MessengerOutboundModule } from './messenger-outbound.module';
import { MessengerAgentToolsService } from './application/agent/messenger-agent-tools.service';
import { MessengerAgentService } from './application/agent/messenger-agent.service';
import { MessengerChatSharedConfigService } from './application/services/messenger-chat-shared-config.service';
import { MessengerChatEnqueueService } from './application/services/messenger-chat-enqueue.service';
import { MessengerChatProcessorService } from './application/services/messenger-chat-processor.service';
import { MessengerChatQueueWorkerService } from './application/services/messenger-chat-queue-worker.service';
import { MessengerRescheduleConfirmationService } from './application/services/messenger-reschedule-confirmation.service';
import { ChatHistoryStoreStartupService } from './application/services/chat-history-store-startup.service';
import { ChatQueueStoreStartupService } from './application/services/chat-queue-store-startup.service';
import { CHAT_QUEUE_STORE } from './domain/repositories/chat-queue.store.port';
import { CHAT_HISTORY_STORE } from './domain/repositories/chat-history.store.port';
import { RedisChatQueueStore } from './infrastructure/persistence/redis-chat-queue.store';
import { ChatHistoryStoreResolver } from './infrastructure/persistence/chat-history.store.resolver';
import { MessengerCalendarPort } from './infrastructure/adapters/messenger-calendar.port';
import { MessengerReschedulePort } from './infrastructure/adapters/messenger-reschedule.port';

/**
 * Self-contained module for the chat pipeline:
 * debounce → rate limit → LLM agent → send.
 *
 * The LLM agent + tool execution delegate to the shared @wispace/chat-agent
 * (`PlatformAgentService` + `PlatformAgentToolsService`); the debounce queue
 * stays messenger-local because of its distributed (Redis) backend, quota
 * messaging and bubble delivery.
 *
 * Exports: MessengerChatEnqueueService, MessengerAgentService,
 * MessengerAgentToolsService, MessengerRescheduleConfirmationService.
 */
@Module({
  imports: [
    CommonModule,
    MessengerOutboundModule,
    ChatRateLimitModule,
    LlmExecutionModule,
    LlmUsageModule,
    StudentReportModule,
    StudyReminderModule,
    DisplayNameModule,
    TypeOrmModule.forFeature([LlmUsageEventEntity, LlmSafetyEventEntity]),
  ],
  providers: [
    MessengerChatSharedConfigService,
    ChatHistoryStoreResolver,
    ChatHistoryStoreStartupService,
    {
      provide: CHAT_HISTORY_STORE,
      useExisting: ChatHistoryStoreResolver,
    },
    {
      provide: PlatformChatHistoryService,
      useFactory: (
        configService: ConfigService,
        redisClient?: { getNativeClient(): unknown } | null,
      ) =>
        new PlatformChatHistoryService(
          configService,
          { envPrefix: 'CHAT_HISTORY_', keyPrefix: 'chat:history:' },
          redisClient,
        ),
      inject: [ConfigService, { token: REDIS_CLIENT, optional: true }],
    },
    {
      provide: PlatformLlmUsageRecorderAdapter,
      useFactory: (
        config: LlmUsageConfigService,
        usageRepo: Repository<LlmUsageEventEntity>,
      ) => new PlatformLlmUsageRecorderAdapter('messenger', config, usageRepo),
      inject: [LlmUsageConfigService, getRepositoryToken(LlmUsageEventEntity)],
    },
    {
      provide: PlatformLlmSafetyEventAdapter,
      useFactory: (
        safetyRepo: Repository<LlmSafetyEventEntity>,
        configService: ConfigService,
      ) =>
        new PlatformLlmSafetyEventAdapter(
          'messenger',
          safetyRepo,
          configService,
        ),
      inject: [getRepositoryToken(LlmSafetyEventEntity), ConfigService],
    },
    {
      provide: PlatformAgentToolsService,
      useFactory: (
        rescheduleService: MessengerRescheduleConfirmationService,
        messengerTools: MessengerAgentToolsService,
      ) =>
        new PlatformAgentToolsService(
          undefined,
          undefined,
          rescheduleService,
          messengerTools.buildToolsOptions(),
        ),
      inject: [
        MessengerRescheduleConfirmationService,
        MessengerAgentToolsService,
      ],
    },
    {
      provide: PlatformAgentService,
      useFactory: (
        configService: ConfigService,
        toolsService: PlatformAgentToolsService,
        historyService: PlatformChatHistoryService,
        usageRecorder: PlatformLlmUsageRecorderAdapter,
        safetyEventService: PlatformLlmSafetyEventAdapter,
        adapter: LlmProviderAdapter,
        messengerTools: MessengerAgentToolsService,
        userDisplayNameService: UserDisplayNameService,
        metrics: MetricsService,
      ) =>
        new PlatformAgentService(
          configService,
          toolsService,
          historyService,
          usageRecorder,
          safetyEventService,
          adapter,
          {
            promptDir: join(__dirname, '../../../shared/prompts'),
            promptFile: 'messenger-chat.system.txt',
            appendHistory: false,
            maxLlmRetries: 0,
            toolExecutionTimeoutMs: 30_000,
            metrics: {
              timeLlmCall: (feature, model, round, fn) =>
                metrics.timeLlmCall(feature, model, round, fn),
              timeTool: (toolName, fn) => metrics.timeTool(toolName, fn),
              llmRoundOutcomeInc: (feature, outcome) =>
                metrics.incRoundOutcome(feature, outcome),
            },
            onBeforeReply: (input) => {
              const activeSpan = trace.getActiveSpan();
              if (activeSpan) {
                activeSpan.setAttributes({
                  'messenger.psid': input.externalUserId,
                  'messenger.user_id': input.userId ?? 0,
                  'llm.feature': 'FREE_FORM_CHAT',
                });
              }
              return Promise.resolve();
            },
            systemPromptSuffix: async (input) => {
              const rawName = await userDisplayNameService.resolveDisplayName({
                psid: input.externalUserId,
                userId: input.userId,
              });
              const sanitized = sanitizeUntrustedTextForLlm(rawName, {
                maxChars: 80,
                unsafePlaceholder: 'Chào bạn nha',
              });
              const displayName = sanitized.text || 'Chào bạn nha';
              return input.userId
                ? `Học viên đã liên kết WISPACE (userId=${input.userId}). Tên gọi: ${displayName}.`
                : `Học viên chưa liên kết WISPACE. Tên gọi: ${displayName}. Nhắc mở Messenger từ link trong app WISPACE nếu cần dữ liệu cá nhân.`;
            },
            tryFastReschedule: (ctx, userText) =>
              messengerTools.tryFastDefaultReschedule(ctx, userText),
          },
        ),
      inject: [
        ConfigService,
        PlatformAgentToolsService,
        PlatformChatHistoryService,
        PlatformLlmUsageRecorderAdapter,
        PlatformLlmSafetyEventAdapter,
        'LLM_PROVIDER_ADAPTER',
        MessengerAgentToolsService,
        UserDisplayNameService,
        MetricsService,
      ],
    },
    RedisChatQueueStore,
    ChatQueueStoreStartupService,
    {
      provide: CHAT_QUEUE_STORE,
      useExisting: RedisChatQueueStore,
    },
    MessengerCalendarPort,
    MessengerReschedulePort,
    MessengerAgentService,
    MessengerAgentToolsService,
    MessengerRescheduleConfirmationService,
    MessengerChatProcessorService,
    MessengerChatEnqueueService,
    MessengerChatQueueWorkerService,
  ],
  exports: [
    MessengerChatEnqueueService,
    MessengerAgentService,
    MessengerAgentToolsService,
    MessengerRescheduleConfirmationService,
    MessengerChatSharedConfigService,
  ],
})
export class ChatPipelineModule {}
