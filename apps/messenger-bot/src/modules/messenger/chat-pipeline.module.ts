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
  RedisChatQueueWorkerService,
} from '@wispace/chat-agent';
import {
  LlmSafetyEventEntity,
  LlmUsageEventEntity,
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
} from '@wispace/chat-metering';
import type { LlmProviderAdapter } from '@wispace/llm-agent';
import {
  sanitizeUntrustedTextForLlm,
  PrivacyStateService,
} from '@wispace/llm-agent';
import { REDIS_CLIENT } from '@wispace/bot-common';
import {
  WispaceConfigService,
  WispaceExerciseService,
} from '@wispace/wispace-client';
import {
  LearnerProfileEntity,
  RescheduleConfirmationEntity,
  RescheduleRecoveryCronService,
  TypeormRescheduleStore,
  PrivacyDataService,
} from '@wispace/database';
import {
  LEARNER_PROFILE_STORE,
  TypeOrmLearnerProfileStore,
  createLearnerProfileRecorder,
  createLearnerProfileSuffix,
} from '@wispace/learner-profile';
import type { LearnerProfileStorePort } from '@wispace/learner-profile';
import { CommonModule } from '../../shared/common/common.module';
import { ChatRateLimitModule } from '../chat-rate-limit/chat-rate-limit.module';
import { LlmExecutionModule } from '../llm-execution/llm-execution.module';
import { LlmExecutionService } from '../llm-execution/application/services/llm-execution.service';
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
import { MessengerRescheduleConfirmationService } from './application/services/messenger-reschedule-confirmation.service';
import { ChatHistoryStoreStartupService } from './application/services/chat-history-store-startup.service';
import { ChatQueueStoreStartupService } from './application/services/chat-queue-store-startup.service';
import { CHAT_QUEUE_STORE } from './domain/repositories/chat-queue.store.port';
import type { ChatQueueStorePort } from './domain/repositories/chat-queue.store.port';
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
    TypeOrmModule.forFeature([
      LlmUsageEventEntity,
      LlmSafetyEventEntity,
      RescheduleConfirmationEntity,
      LearnerProfileEntity,
    ]),
  ],
  providers: [
    MessengerChatSharedConfigService,
    {
      provide: WispaceConfigService,
      useFactory: (configService: ConfigService) =>
        new WispaceConfigService((key) => configService.get<string>(key)),
      inject: [ConfigService],
    },
    {
      provide: WispaceExerciseService,
      useFactory: (configService: WispaceConfigService) =>
        new WispaceExerciseService(
          'x-psid',
          configService.buildPrecreateExerciseClientConfig(),
        ),
      inject: [WispaceConfigService],
    },
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
      // Messenger owns its tool executor (LLM report, StudyDataPort calendar
      // tools, subscription upsert, quick-reply follow-ups) — the shared
      // PlatformAgentToolsService stays the Discord/Zalo implementation.
      provide: PlatformAgentToolsService,
      useExisting: MessengerAgentToolsService,
    },
    {
      provide: LEARNER_PROFILE_STORE,
      useClass: TypeOrmLearnerProfileStore,
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
        llmExecution: LlmExecutionService,
        learnerProfileStore: LearnerProfileStorePort,
      ) => {
        const learnerProfileSuffix = createLearnerProfileSuffix(
          learnerProfileStore,
          'messenger',
        );
        return new PlatformAgentService(
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
            // Chat flows through the same execution-control path as reports
            // and reminders: limiter + circuit breaker + retry + deadline.
            llmExecution,
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
              const base = input.userId
                ? `Học viên đã liên kết WISPACE (userId=${input.userId}). Tên gọi: ${displayName}.`
                : `Học viên chưa liên kết WISPACE. Tên gọi: ${displayName}. Nhắc mở Messenger từ link trong app WISPACE nếu cần dữ liệu cá nhân.`;
              const profileSection = await learnerProfileSuffix(input);
              return profileSection ? `${base}\n\n${profileSection}` : base;
            },
            // Learner profile (#207 item 3): persist server-derived facts
            // (band target, exam date) from successful tool results.
            onToolResult: createLearnerProfileRecorder(
              learnerProfileStore,
              'messenger',
            ),
            tryFastReschedule: (ctx, userText) =>
              messengerTools.tryFastDefaultReschedule(ctx, userText),
          },
        );
      },
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
        LlmExecutionService,
        LEARNER_PROFILE_STORE,
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
    {
      provide: TypeormRescheduleStore,
      useFactory: (repo: Repository<RescheduleConfirmationEntity>) =>
        new TypeormRescheduleStore<string>('messenger', repo),
      inject: [getRepositoryToken(RescheduleConfirmationEntity)],
    },
    RescheduleRecoveryCronService,
    MessengerAgentService,
    MessengerAgentToolsService,
    {
      provide: MessengerRescheduleConfirmationService,
      useFactory: (
        calendarPort: MessengerCalendarPort,
        reschedulePort: MessengerReschedulePort,
        store: TypeormRescheduleStore<string>,
      ) =>
        new MessengerRescheduleConfirmationService(
          calendarPort,
          reschedulePort,
          store,
        ),
      inject: [
        MessengerCalendarPort,
        MessengerReschedulePort,
        TypeormRescheduleStore,
      ],
    },
    MessengerChatProcessorService,
    MessengerChatEnqueueService,
    PrivacyStateService,
    PrivacyDataService,
    {
      provide: RedisChatQueueWorkerService,
      useFactory: (
        configService: ConfigService,
        queueStore: ChatQueueStorePort,
        processor: MessengerChatProcessorService,
      ) =>
        new RedisChatQueueWorkerService(
          configService,
          (limit) => queueStore.listPsidsReadyForFlush(limit),
          (externalUserId) => processor.flushReady(externalUserId),
        ),
      inject: [ConfigService, CHAT_QUEUE_STORE, MessengerChatProcessorService],
    },
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
