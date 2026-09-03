import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { trace } from '@opentelemetry/api';
import { Repository } from 'typeorm';
import { WispaceModule } from '../wispace/wispace.module';
import type { CalendarPort, ReschedulePort } from '@wispace/reschedule-confirm';
import {
  PlatformAgentService,
  PlatformAgentToolsService,
  PlatformChatHistoryService,
  RedisChatQueueWorkerService,
  CLARIFICATION_STATE_STORE,
  LlmContentClassifier,
} from '@wispace/chat-agent';
import type { ClarificationStateStore } from '@wispace/chat-agent';
import {
  LlmSafetyEventEntity,
  LlmUsageEventEntity,
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
  toUsageRecorderMetrics,
} from '@wispace/chat-metering';
import type { LlmProviderAdapter } from '@wispace/llm-agent';
import {
  sanitizeUntrustedTextForLlm,
  PrivacyStateService,
} from '@wispace/llm-agent';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import {
  WispaceConfigService,
  PrecreateExerciseApiClient,
} from '@wispace/wispace-client';
import {
  LearnerProfileEntity,
  RescheduleConfirmationEntity,
  RescheduleRecoveryCronService,
  TypeormRescheduleStore,
} from '@wispace/database';
import {
  LEARNER_PROFILE_STORE,
  TypeOrmLearnerProfileStore,
  createLearnerProfileRecorder,
  createLearnerProfileSuffix,
} from '@wispace/learner-profile';
import type { LearnerProfileStorePort } from '@wispace/learner-profile';
import { CommonModule } from '../../shared/common/common.module';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ChatRateLimitModule } from '../chat-rate-limit/chat-rate-limit.module';
import { LlmExecutionModule } from '../llm-execution/llm-execution.module';
import { LlmExecutionService } from '../llm-execution/application/services/llm-execution.service';
import { LlmUsageModule } from '../llm-usage/llm-usage.module';
import { LlmUsageConfigService } from '../llm-usage/application/services/llm-usage-config.service';
import { StudentReportModule } from '../student-report/student-report.module';
import { StudyReminderModule } from '../study-reminder/study-reminder.module';
import { DisplayNameModule } from '../display-name/display-name.module';
import { UserDisplayNameService } from '../display-name/application/user-display-name.service';
import { BotMetricsService } from '@wispace/bot-metrics';
import { MessengerOutboundModule } from './messenger-outbound.module';
import { UserLinkingModule } from './user-linking.module';
import { MessengerAgentToolsService } from './application/agent/messenger-agent-tools.service';
import {
  MESSENGER_TOOL_IDENTITY_PROVIDER,
  MESSENGER_TOOL_POLICY_DENIED_INC,
  MESSENGER_WRITE_TOOL_BUDGET,
  MESSENGER_WRITE_TOOL_PER_MESSAGE_CAPS,
  MESSENGER_WRITE_TOOL_BUDGET_DENIED_INC,
} from './application/agent/messenger-agent-tools.service';
import { PlatformWriteToolBudgetService } from '@wispace/chat-metering';
import { buildWriteToolDailyBudgetMessage } from '@wispace/llm-agent';
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
import {
  STUDY_REMINDER_OPERATIONS_PORT,
  type StudyReminderOperationsPort,
} from '../study-reminder/domain/ports/study-reminder-operations.port';
import { MESSENGER_REPOSITORY } from './domain/repositories/messenger.repository.port';

/** Fallback model id for the #649 input classifier (see `.env.example`). */
const DEFAULT_CLASSIFIER_MODEL = 'google/gemini-2.0-flash-lite';

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
    DatabaseModule,
    MessengerOutboundModule,
    ChatRateLimitModule,
    LlmExecutionModule,
    LlmUsageModule,
    StudentReportModule,
    StudyReminderModule,
    WispaceModule,
    DisplayNameModule,
    UserLinkingModule,
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
      provide: MESSENGER_TOOL_IDENTITY_PROVIDER,
      useFactory:
        (
          repository: import('./domain/repositories/messenger-mapping.repository.port').MessengerMappingRepositoryPort,
        ) =>
        async (externalUserId: string) => {
          const mapping =
            await repository.findActiveMappingByPsid(externalUserId);
          if (!mapping?.userId) return undefined;
          return {
            userId: mapping.userId,
            mappingVersion: `${mapping.id}:${mapping.updatedAt}:${mapping.mappingGeneration ?? '1'}`,
          };
        },
      inject: [MESSENGER_REPOSITORY],
    },
    {
      provide: MESSENGER_TOOL_POLICY_DENIED_INC,
      useFactory:
        (metrics: BotMetricsService) => (toolName: string, reason: string) =>
          metrics.incLlmToolPolicyDenied(toolName, 'messenger', reason),
      inject: [BotMetricsService],
    },
    {
      provide: WispaceConfigService,
      useFactory: (configService: ConfigService) =>
        new WispaceConfigService((key) => configService.get<string>(key)),
      inject: [ConfigService],
    },
    {
      provide: PrecreateExerciseApiClient,
      useFactory: (configService: WispaceConfigService) =>
        new PrecreateExerciseApiClient(
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
        metrics: BotMetricsService,
      ) =>
        new PlatformLlmUsageRecorderAdapter(
          'messenger',
          config,
          usageRepo,
          toUsageRecorderMetrics(metrics),
        ),
      inject: [
        LlmUsageConfigService,
        getRepositoryToken(LlmUsageEventEntity),
        BotMetricsService,
      ],
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
        metrics: BotMetricsService,
        llmExecution: LlmExecutionService,
        learnerProfileStore: LearnerProfileStorePort,
        redisClient: RedisClientPort,
        clarificationStore: ClarificationStateStore,
        currentIdentityProvider: (
          externalUserId: string,
        ) => Promise<{ userId: number; mappingVersion: string } | undefined>,
      ) => {
        const learnerProfileSuffix = createLearnerProfileSuffix(
          learnerProfileStore,
          'messenger',
        );
        // Always constructed (the constructor does no I/O). Whether it runs is
        // decided by LLM_INPUT_CLASSIFIER_ENABLED inside PlatformAgentService —
        // one source of truth for the flag (#649).
        const classifierTimeoutRaw = Number(
          configService.get<string>('LLM_INPUT_CLASSIFIER_TIMEOUT_MS'),
        );
        const contentClassifier = new LlmContentClassifier({
          adapter,
          model:
            configService.get<string>('LLM_INPUT_CLASSIFIER_MODEL')?.trim() ||
            DEFAULT_CLASSIFIER_MODEL,
          timeoutMs:
            Number.isFinite(classifierTimeoutRaw) && classifierTimeoutRaw > 0
              ? Math.floor(classifierTimeoutRaw)
              : 1200,
          logger: new Logger('LlmContentClassifier'),
        });
        return new PlatformAgentService(
          configService,
          toolsService,
          historyService,
          usageRecorder,
          safetyEventService,
          adapter,
          {
            platform: 'messenger',
            currentIdentityProvider,
            clarificationStore,
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
              observationOutcomeInc: (toolName, outcome) =>
                metrics.incObservationOutcome(toolName, 'messenger', outcome),
              toolPolicyDeniedInc: (toolName, reason) =>
                metrics.incLlmToolPolicyDenied(toolName, 'messenger', reason),
              degradedModeInc: (event) => metrics.incLlmDegradedMode(event),
              injectionBlockedInc: (source) =>
                metrics.incLlmInjectionBlocked(source, 'messenger'),
              classifierVerdictInc: (label, mode) =>
                metrics.incClassifierVerdict(label, mode, 'messenger'),
            },
            clarificationOutcomeInc: (outcome) =>
              metrics.incClarificationOutcome(outcome),
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
                ? `Học viên đã liên kết WISPACE. Tên gọi: ${displayName}.`
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
            contentClassifier,
          },
          redisClient,
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
        BotMetricsService,
        LlmExecutionService,
        LEARNER_PROFILE_STORE,
        REDIS_CLIENT,
        CLARIFICATION_STATE_STORE,
        MESSENGER_TOOL_IDENTITY_PROVIDER,
      ],
    },
    RedisChatQueueStore,
    ChatQueueStoreStartupService,
    {
      provide: CHAT_QUEUE_STORE,
      useExisting: RedisChatQueueStore,
    },
    {
      provide: 'MessengerCalendarPort',
      useFactory: (
        operations: StudyReminderOperationsPort,
      ): CalendarPort<string> => ({
        // Keep the stage lookup scoped to the caller's WISPACE user.
        listUpcomingEntries: (psid: string, userId: number) =>
          operations
            .listEntries(psid, userId, { timeRange: 'upcoming' })
            .then((result) =>
              result.entries.map((entry) => ({
                calendarId: entry.calendarId,
                scheduledTimeLabel: entry.scheduledTimeLabel,
                ownerUserId: entry.ownerUserId,
              })),
            ),
      }),
      inject: [STUDY_REMINDER_OPERATIONS_PORT],
    },
    {
      provide: 'MessengerReschedulePort',
      useFactory: (
        operations: StudyReminderOperationsPort,
      ): ReschedulePort<string> => ({
        rescheduleSession: (params) =>
          operations.rescheduleSession({
            psid: params.externalId,
            userId: params.userId,
            calendarId: params.calendarId,
            schedulingMode: params.schedulingMode,
            newLocalDate: params.newLocalDate,
            newTime: params.newTime,
          }),
      }),
      inject: [STUDY_REMINDER_OPERATIONS_PORT],
    },
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
      provide: MESSENGER_WRITE_TOOL_BUDGET,
      useExisting: PlatformWriteToolBudgetService,
    },
    {
      provide: MESSENGER_WRITE_TOOL_PER_MESSAGE_CAPS,
      useFactory: (b: PlatformWriteToolBudgetService) => b.perMessageCaps(),
      inject: [PlatformWriteToolBudgetService],
    },
    {
      provide: MESSENGER_WRITE_TOOL_BUDGET_DENIED_INC,
      useFactory:
        (m: BotMetricsService) => (tool: string, reason: 'per_message') =>
          m.incWriteToolBudgetDenied(tool, 'messenger', reason),
      inject: [BotMetricsService],
    },
    {
      provide: MessengerRescheduleConfirmationService,
      useFactory: (
        calendarPort: CalendarPort<string>,
        reschedulePort: ReschedulePort<string>,
        store: TypeormRescheduleStore<string>,
        writeToolBudget: PlatformWriteToolBudgetService,
        policyDeniedInc: (toolName: string, reason: string) => void,
      ) =>
        new MessengerRescheduleConfirmationService(
          calendarPort,
          reschedulePort,
          store,
          {
            consumeRescheduleBudget: (userId: number, externalId: string) =>
              writeToolBudget.consumeDaily(
                String(externalId),
                userId,
                'reschedule_study_session',
              ),
            refundRescheduleBudget: (userId: number, _externalId: string) =>
              writeToolBudget.refundDaily(userId, 'reschedule_study_session'),
            rescheduleBudgetExceededMessage: buildWriteToolDailyBudgetMessage(
              'reschedule_study_session',
            ),
            scopeFailureInc: (reason) =>
              policyDeniedInc('reschedule_study_session', reason),
          },
        ),
      inject: [
        'MessengerCalendarPort',
        'MessengerReschedulePort',
        TypeormRescheduleStore,
        PlatformWriteToolBudgetService,
        MESSENGER_TOOL_POLICY_DENIED_INC,
      ],
    },
    MessengerChatProcessorService,
    MessengerChatEnqueueService,
    {
      provide: PrivacyStateService,
      useFactory: (sharedConfig: MessengerChatSharedConfigService) =>
        new PrivacyStateService(sharedConfig.getPrivacyConfirmTtlMs()),
      inject: [MessengerChatSharedConfigService],
    },
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
          queueStore.reconcile ? () => queueStore.reconcile!() : undefined,
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
    PlatformChatHistoryService,
  ],
})
export class ChatPipelineModule {}
