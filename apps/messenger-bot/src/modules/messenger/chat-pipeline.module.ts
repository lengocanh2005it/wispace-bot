import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { join } from 'path';
import { trace } from '@opentelemetry/api';
import { Repository } from 'typeorm';
import { WispaceModule } from '../wispace/wispace.module';
import type {
  CalendarPort,
  ReschedulePort,
} from '@wispace/reschedule-confirm/core';
import {
  PlatformAgentService,
  PlatformAgentToolsService,
  PlatformChatHistoryService,
  ChatRuntimeConfig,
  RedisChatQueueWorkerService,
  CLARIFICATION_STATE_STORE,
  LlmContentClassifier,
  readChatFlushRetrySettings,
  type ClarificationStateStore,
} from '@wispace/chat-agent';
import {
  LlmSafetyEventEntity,
  LlmUsageEventEntity,
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
  PlatformWriteToolBudgetService,
} from '@wispace/chat-metering/adapters';
import { toUsageRecorderMetrics } from '@wispace/chat-metering/core';
import type { LlmProviderAdapter } from '@wispace/llm-agent/core';
import { PrivacyStateService } from '@wispace/llm-agent/adapters';
import {
  sanitizeUntrustedTextForLlm,
  buildWriteToolDailyBudgetMessage,
} from '@wispace/llm-agent/core';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import {
  ADVISORY_LOCKS,
  PgAdvisoryLockService,
} from '@wispace/bot-common/locks';
import { WispaceConfigService } from '@wispace/wispace-client/adapters';
import { PrecreateExerciseApiClient } from '@wispace/wispace-client/core';
import {
  LearnerProfileEntity,
  PrivacyDataService,
  RescheduleConfirmationEntity,
} from '@wispace/database';
import {
  RescheduleRecoveryCronService,
  TypeormRescheduleStore,
} from '@wispace/reschedule-confirm/adapters';
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
import {
  MessengerAgentToolsService,
  MESSENGER_TOOL_IDENTITY_PROVIDER,
  MESSENGER_TOOL_POLICY_DENIED_INC,
  MESSENGER_WRITE_TOOL_BUDGET,
  MESSENGER_WRITE_TOOL_PER_MESSAGE_CAPS,
  MESSENGER_WRITE_TOOL_BUDGET_DENIED_INC,
} from './application/agent/messenger-agent-tools.service';
import { AgentReplyAdapter } from './infrastructure/adapters/agent-reply.adapter';
import { MessengerOutboundService } from './application/services/messenger-outbound.service';
import { ChatRateLimitService } from '@messenger/modules/chat-rate-limit/application/services/chat-rate-limit.service';
import type { AgentReplyPort } from './application/ports/agent-reply.port';
import {
  AgentExerciseCreateAdapter,
  AgentGoalsReadAdapter,
} from './infrastructure/adapters/agent-tool-edges.adapter';
import { AGENT_REPLY } from './application/ports/agent-reply.port';
import { MESSENGER_CHAT_PIPELINE_PORTS } from './application/ports/messenger-chat-pipeline-ports.port';
import type { MessengerChatPipelinePorts } from './application/ports/messenger-chat-pipeline-ports.port';
import { createMessengerChatPipelineAdapters } from './infrastructure/adapters/messenger-chat-pipeline-adapters';
import {
  CHAT_FLUSH_SETTINGS,
  CHAT_HISTORY,
  PRIVACY_DATA,
  PRIVACY_STATE,
  type ChatFlushSettings,
} from './application/chat-processing-seams.port';
import {
  AGENT_EXERCISE_CREATE,
  AGENT_GOALS_READ,
} from './application/agent/agent-tool-edges.port';
import { MessengerChatSharedConfigService } from './application/services/messenger-chat-shared-config.service';
import { MessengerChatEnqueueService } from './application/services/messenger-chat-enqueue.service';
import {
  buildMessengerClassifierConfig,
  resolveMessengerClassifierModel,
} from './classifier-config';
import { MessengerChatProcessorService } from './application/services/messenger-chat-processor.service';
import { MessengerRescheduleConfirmationService } from './application/services/messenger-reschedule-confirmation.service';
import { ChatHistoryStoreStartupService } from './infrastructure/persistence/chat-history-store-startup.service';
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
import {
  readEnvBoolean,
  readEnvPositiveInt,
} from '@messenger/shared/config/env-helpers';

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
    {
      provide: ChatRuntimeConfig,
      useFactory: (configService: ConfigService) =>
        new ChatRuntimeConfig(configService),
      inject: [ConfigService],
    },
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
      useFactory: (configService: ConfigService, metrics: BotMetricsService) =>
        new WispaceConfigService(
          (key) => configService.get<string>(key),
          metrics,
        ),
      inject: [ConfigService, BotMetricsService],
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
        runtimeConfig: ChatRuntimeConfig,
        redisClient?: { getNativeClient(): unknown } | null,
      ) =>
        new PlatformChatHistoryService(
          configService,
          { envPrefix: 'CHAT_HISTORY_', keyPrefix: 'chat:history:' },
          redisClient,
          runtimeConfig,
        ),
      inject: [
        ConfigService,
        ChatRuntimeConfig,
        { token: REDIS_CLIENT, optional: true },
      ],
    },
    {
      // #1088: the chat processor depends on narrow seams; the concrete
      // history/privacy services stay bound to the same singletons.
      provide: CHAT_HISTORY,
      useExisting: PlatformChatHistoryService,
    },
    {
      provide: PRIVACY_DATA,
      useExisting: PrivacyDataService,
    },
    {
      provide: PRIVACY_STATE,
      useExisting: PrivacyStateService,
    },
    {
      // One module owns env resolution so the queue worker and the processor
      // cannot drift on the debounce/stuck/retry numbers.
      provide: CHAT_FLUSH_SETTINGS,
      useFactory: (
        configService: ConfigService,
        runtimeConfig: ChatRuntimeConfig,
      ): ChatFlushSettings => {
        const retry = readChatFlushRetrySettings(configService);
        return {
          debounceMs: runtimeConfig.debounceMs,
          processingStuckMs: runtimeConfig.processingStuckMs,
          retryEnabled: retry.enabled,
          retryDelayMs: retry.delayMs,
        };
      },
      inject: [ConfigService, ChatRuntimeConfig],
    },
    {
      provide: MESSENGER_CHAT_PIPELINE_PORTS,
      useFactory: (
        chatRateLimitService: ChatRateLimitService,
        historyService: PlatformChatHistoryService,
        agentService: AgentReplyPort,
        outboundService: MessengerOutboundService,
        configService: ConfigService,
      ): MessengerChatPipelinePorts =>
        createMessengerChatPipelineAdapters(
          chatRateLimitService,
          historyService,
          agentService,
          outboundService,
          configService,
        ),
      inject: [
        ChatRateLimitService,
        PlatformChatHistoryService,
        AGENT_REPLY,
        MessengerOutboundService,
        ConfigService,
      ],
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
        rescheduleConfirmationService: MessengerRescheduleConfirmationService,
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
        const classifierConfig = buildMessengerClassifierConfig((key) =>
          configService.get<string>(key)?.trim(),
        );
        const classifierModel = resolveMessengerClassifierModel({
          ...classifierConfig,
          executionEnabled: readEnvBoolean(
            configService,
            'LLM_EXECUTION_ENABLED',
            true,
          ),
        });
        const contentClassifier = new LlmContentClassifier({
          adapter,
          execution: llmExecution,
          executionEnabled: readEnvBoolean(
            configService,
            'LLM_EXECUTION_ENABLED',
            true,
          ),
          model: classifierModel,
          maxInputChars: Math.max(
            1,
            readEnvPositiveInt(
              configService,
              'LLM_INPUT_CLASSIFIER_MAX_INPUT_CHARS',
              512,
            ),
          ),
          timeoutMs: readEnvPositiveInt(
            configService,
            'LLM_INPUT_CLASSIFIER_TIMEOUT_MS',
            1200,
          ),
          onInputShape: (shape) =>
            metrics.incClassifierInput(shape, 'messenger'),
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
              promptCanaryHitInc: () =>
                metrics.incLlmPromptCanaryHit('messenger'),
              classifierVerdictInc: (label, mode) =>
                metrics.incClassifierVerdict(label, mode, 'messenger'),
              totalProviderAttemptsInc: (feature, attempts, outcome) =>
                metrics.incLlmTotalProviderAttempts(feature, attempts, outcome),
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
              return {
                identityDisplayName: base,
                learnerProfile: profileSection,
              };
            },
            // Learner profile (#207 item 3): persist server-derived facts
            // (band target, exam date) from successful tool results.
            onToolResult: createLearnerProfileRecorder(
              learnerProfileStore,
              'messenger',
            ),
            tryFastReschedule: (ctx, userText, signal) =>
              messengerTools.tryFastDefaultReschedule(ctx, userText, signal),
            cancelPendingReschedule: (externalUserId, approvalToken) =>
              rescheduleConfirmationService.cancelForUser(
                externalUserId,
                approvalToken,
              ),
            contentClassifier,
            classifierUsage: {
              provider: adapter.providerName,
              model: classifierModel,
            },
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
        MessengerRescheduleConfirmationService,
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
        listUpcomingEntries: (
          psid: string,
          userId: number,
          options?: { signal?: AbortSignal },
        ) =>
          operations
            .listEntries(psid, userId, {
              timeRange: 'upcoming',
              ...(options?.signal ? { signal: options.signal } : {}),
            })
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
    {
      provide: RescheduleRecoveryCronService,
      useFactory: (
        store: TypeormRescheduleStore<string>,
        metrics: BotMetricsService,
        pgLock: PgAdvisoryLockService,
      ) =>
        new RescheduleRecoveryCronService(store, metrics, {
          pgLock,
          lockId: ADVISORY_LOCKS.RESCHEDULE_RECOVERY,
        }),
      inject: [
        TypeormRescheduleStore,
        BotMetricsService,
        PgAdvisoryLockService,
      ],
    },
    AgentReplyAdapter,
    {
      provide: AGENT_REPLY,
      useExisting: AgentReplyAdapter,
    },
    AgentGoalsReadAdapter,
    {
      provide: AGENT_GOALS_READ,
      useExisting: AgentGoalsReadAdapter,
    },
    AgentExerciseCreateAdapter,
    {
      provide: AGENT_EXERCISE_CREATE,
      useExisting: AgentExerciseCreateAdapter,
    },
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
        runtimeConfig: ChatRuntimeConfig,
        queueStore: ChatQueueStorePort,
        processor: MessengerChatProcessorService,
      ) =>
        new RedisChatQueueWorkerService(
          configService,
          (limit) => queueStore.listPsidsReadyForFlush(limit),
          (externalUserId) => processor.flushReady(externalUserId),
          queueStore.reconcile ? () => queueStore.reconcile!() : undefined,
          runtimeConfig,
        ),
      inject: [
        ConfigService,
        ChatRuntimeConfig,
        CHAT_QUEUE_STORE,
        MessengerChatProcessorService,
      ],
    },
  ],
  exports: [
    MessengerChatEnqueueService,
    AGENT_REPLY,
    AGENT_GOALS_READ,
    AGENT_EXERCISE_CREATE,
    MessengerAgentToolsService,
    MessengerRescheduleConfirmationService,
    MessengerChatSharedConfigService,
    PlatformChatHistoryService,
    PRIVACY_DATA,
  ],
})
export class ChatPipelineModule {}
