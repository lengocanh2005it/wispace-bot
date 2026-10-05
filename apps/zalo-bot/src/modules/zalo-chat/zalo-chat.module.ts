import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { join } from 'path';
import { readEnvBoolean, readEnvPositiveInt } from '@wispace/bot-common/config';
import { consoleRedactedLogger } from '@wispace/bot-common/logging';
import {
  OUTBOUND_DELIVERY_JOURNAL,
  OUTBOUND_RATE_LIMIT,
  type OutboundDeliveryJournalPort,
} from '@wispace/contracts';
import {
  createLlmProviderAdapterFromEnv,
  createEnvLlmExecutionPort,
  createLlmAdmissionCoordinator,
} from '@wispace/llm-agent/adapters';
import {
  buildLlmExecutionConfig,
  LlmAdmissionCoordinator,
  buildWriteToolDailyBudgetMessage,
} from '@wispace/llm-agent/core';
import type {
  LlmProviderAdapter,
  LlmExecutionPort,
} from '@wispace/llm-agent/core';
import {
  ChatMeteringModule,
  ChatIdempotencyEntity,
  PlatformChatRateLimitService,
  PlatformWriteToolBudgetService,
  LlmSafetyCleanupService,
  provideWiredUsageRecorder,
} from '@wispace/chat-metering/adapters';
import {
  PlatformAgentService,
  LlmContentClassifier,
  buildClassifierConfig,
  resolveClassifierModel,
  PlatformAgentToolsService,
  PlatformChatHistoryService,
  PlatformChatQueueService,
  ChatRuntimeConfig,
  RedisChatQueueStore,
  PLATFORM_CHAT_QUEUE_STORE,
  CLARIFICATION_STATE_STORE,
  createChatPipelineAdapters,
  createPlatformChatProviders,
  recordChatQueueReconciliationMetrics,
} from '@wispace/chat-agent';
import type {
  ChatQueueStorePort,
  ClarificationStateStore,
  PlatformChatAgentDynamicOptions,
} from '@wispace/chat-agent';
import {
  WispaceCalendarService,
  WispaceConfigService,
  WispaceGoalsService,
} from '@wispace/wispace-client/adapters';
import {
  PrecreateExerciseApiClient,
  WispaceDataCache,
} from '@wispace/wispace-client/core';
import {
  ZaloCalendarCapabilityAdapter,
  ZaloExerciseCapabilityAdapter,
  ZaloGoalsCapabilityAdapter,
  ZaloWispaceCacheInvalidationAdapter,
} from './infrastructure/adapters/zalo-wispace-capability.adapters';
import {
  ADVISORY_LOCKS,
  PgAdvisoryLockService,
} from '@wispace/bot-common/locks';
import { BotCommonModule } from '@wispace/bot-common/guard';
import {
  REDIS_CLIENT,
  OutboundRateLimiter,
  type RedisClientPort,
} from '@wispace/bot-common/redis';
import { BotMetricsService } from '@wispace/bot-metrics';
import { ZaloOauthModule } from '../zalo-oauth/zalo-oauth.module';
import { ZaloAccountLinkService } from '@zalo/modules/zalo-oauth/infrastructure/persistence/zalo-account-link.service';
import { ZaloWelcomeService } from '@zalo/modules/zalo-oauth/application/services/zalo-welcome.service';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { ZaloOutboundService } from './application/services/zalo-outbound.service';
import { ZaloChatService } from './application/services/zalo-chat.service';
import {
  ZALO_OUTBOUND,
  type ZaloOutboundPort,
} from './application/ports/zalo-outbound.port';
import { ZALO_WELCOME } from './application/ports/zalo-welcome.port';
import { ZALO_CLARIFICATION_AGENT } from './application/ports/zalo-clarification-agent.port';
import { ZALO_OUTBOUND_TRANSPORT } from './application/ports/zalo-outbound-transport.port';
import { ZALO_CHAT_QUEUE } from './application/ports/zalo-chat-queue.port';
import { ZaloSendApiAdapter } from './infrastructure/adapters/zalo-send-api.adapter';
import { RescheduleConfirmationService } from '@wispace/reschedule-confirm/core';
import type {
  CalendarPort,
  ReschedulePort,
} from '@wispace/reschedule-confirm/core';
import {
  PlatformStudyCalendarCommandService,
  StudyReminderJobEntity,
  TypeormStudyReminderJobRepository,
} from '@wispace/study-reminder-shared/adapters';
import { STUDY_REMINDER_JOB_REPOSITORY } from '@wispace/study-reminder-shared/core';
import {
  PlatformDeadLetterCronService,
  PlatformDeadLetterService,
  WebhookDeadLetterEntity,
  DeliveryLogService,
  ScheduledReportClaimEntity,
  RescheduleConfirmationEntity,
  RescheduleConfirmationAttemptEntity,
  LearnerProfileEntity,
  buildLearnerUsageQuery,
  buildLegacyLearnerUsageQuery,
} from '@wispace/database';
import {
  RescheduleRecoveryCronService,
  TypeormRescheduleAttemptStore,
  TypeormRescheduleStore,
  createRescheduleProviders,
} from '@wispace/reschedule-confirm/adapters';
import {
  CleanupCronService,
  PlatformCleanupCronService,
  PlatformLinkAuditCleanupService,
} from '@wispace/cleanup-cron/adapters';
import { ZaloMessageLogEntity } from '../../infrastructure/database/entities/zalo-message-log.entity';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { DataSource, Repository } from 'typeorm';

const NOT_LINKED_MESSAGE =
  'Bạn chưa liên kết tài khoản WISPACE với Zalo. Liên kết tài khoản để sử dụng tính năng này nhé.';

const REGISTER_REPORT_MESSAGE =
  'Bạn đã được đăng ký nhận báo cáo học tập qua Zalo mỗi sáng lúc 08:00 (không cần đăng ký riêng).';

const RESCHEDULE_CONFIRM_SUFFIX =
  '\n\nNhắn "xác nhận <mã>" để đồng ý, hoặc "hủy" để hủy.';

export const ZALO_AGENT_OPTIONS = 'ZALO_AGENT_OPTIONS';

@Module({
  imports: [
    BotCommonModule,
    DatabaseModule,
    ZaloOauthModule,
    ZaloWispaceModule,
    ChatMeteringModule.forPlatform('zalo', {
      learnerUsageQuery: buildLearnerUsageQuery,
      legacyLearnerUsageQuery: buildLegacyLearnerUsageQuery,
    }),
    TypeOrmModule.forFeature([
      ChatIdempotencyEntity,
      ZaloMessageLogEntity,
      WebhookDeadLetterEntity,
      ZaloOauthStateEntity,
      ScheduledReportClaimEntity,
      RescheduleConfirmationEntity,
      RescheduleConfirmationAttemptEntity,
      LearnerProfileEntity,
      StudyReminderJobEntity,
    ]),
  ],
  providers: [
    {
      // #1450: `ZaloOutboundService` is provided in this same module, so the
      // token it injects is bound here. `useExisting` keeps the exact instance
      // the `@Global()` RedisModule exports.
      provide: OUTBOUND_RATE_LIMIT,
      useExisting: OutboundRateLimiter,
    },
    {
      provide: ChatRuntimeConfig,
      useFactory: (configService: ConfigService) =>
        new ChatRuntimeConfig(configService),
      inject: [ConfigService],
    },
    ZaloChatService,
    ZaloWelcomeService,
    {
      // The chat service asks zalo-oauth for a welcome through this port
      // rather than importing its concrete service.
      provide: ZALO_WELCOME,
      useExisting: ZaloWelcomeService,
    },
    {
      provide: ZALO_CLARIFICATION_AGENT,
      useExisting: PlatformAgentService,
    },
    TypeormStudyReminderJobRepository,
    // #549 — shadows forPlatform's unwired recorder with the metrics-wired one.
    provideWiredUsageRecorder('zalo', BotMetricsService),
    {
      provide: STUDY_REMINDER_JOB_REPOSITORY,
      useExisting: TypeormStudyReminderJobRepository,
    },
    {
      provide: 'LLM_PROVIDER_ADAPTER',
      useFactory: (
        configService: ConfigService,
        metrics: BotMetricsService,
      ): LlmProviderAdapter =>
        createLlmProviderAdapterFromEnv(
          (key) => configService.get<string>(key)?.trim(),
          {
            onCircuitEvent: (event) =>
              metrics.incLlmProviderCircuitEvent(
                event.provider,
                event.action,
                event.reason,
              ),
            onProviderAttempt: (provider, feature) =>
              metrics.incLlmProviderAttempt(provider, feature),
            onProviderOutcome: (provider, outcome) =>
              metrics.incLlmProviderOutcome(provider, outcome),
            onProviderNeverSucceeded: (provider) =>
              metrics.incLlmProviderNeverSucceeded(provider),
            onProvidersExhausted: (providers, feature) =>
              metrics.incLlmProvidersExhausted(providers.length, feature),
          },
        ),
      inject: [ConfigService, BotMetricsService],
    },
    {
      provide: 'LLM_ADMISSION_COORDINATOR',
      useFactory: (
        configService: ConfigService,
        metrics: BotMetricsService,
        redisClient?: RedisClientPort | null,
      ): LlmAdmissionCoordinator => {
        const config = buildLlmExecutionConfig((key) =>
          configService.get<string>(key)?.trim(),
        );
        return createLlmAdmissionCoordinator(
          config,
          consoleRedactedLogger,
          metrics.llmAdmission,
          config.globalConcurrencyEnabled ? (redisClient ?? null) : null,
        );
      },
      inject: [
        ConfigService,
        BotMetricsService,
        { token: REDIS_CLIENT, optional: true },
      ],
    },
    {
      provide: 'LLM_EXECUTION_PORT',
      useFactory: (
        configService: ConfigService,
        adapter: LlmProviderAdapter,
        metrics: BotMetricsService,
        admission: LlmAdmissionCoordinator,
      ): LlmExecutionPort => {
        const config = buildLlmExecutionConfig((key) =>
          configService.get<string>(key)?.trim(),
        );
        return createEnvLlmExecutionPort(
          {
            ...config,
            redis: null,
          },
          adapter,
          consoleRedactedLogger,
          metrics.llmAdmission,
          admission,
        );
      },
      inject: [
        ConfigService,
        'LLM_PROVIDER_ADAPTER',
        BotMetricsService,
        'LLM_ADMISSION_COORDINATOR',
      ],
    },
    {
      provide: 'LLM_REPORT_EXECUTION_PORT',
      useFactory: (
        configService: ConfigService,
        adapter: LlmProviderAdapter,
        metrics: BotMetricsService,
        admission: LlmAdmissionCoordinator,
      ): LlmExecutionPort => {
        const config = buildLlmExecutionConfig((key) =>
          configService.get<string>(key)?.trim(),
        );
        return createEnvLlmExecutionPort(
          { ...config, redis: null },
          adapter,
          consoleRedactedLogger,
          metrics.llmAdmission,
          admission,
        );
      },
      inject: [
        ConfigService,
        'LLM_PROVIDER_ADAPTER',
        BotMetricsService,
        'LLM_ADMISSION_COORDINATOR',
      ],
    },
    {
      provide: DeliveryLogService,
      useFactory: (repo: Repository<ZaloMessageLogEntity>) =>
        new DeliveryLogService(repo, 'zalo'),
      inject: [getRepositoryToken(ZaloMessageLogEntity)],
    },
    {
      provide: PlatformDeadLetterService,
      useFactory: (repo: Repository<WebhookDeadLetterEntity>) =>
        new PlatformDeadLetterService('zalo', repo),
      inject: [getRepositoryToken(WebhookDeadLetterEntity)],
    },
    {
      provide: OUTBOUND_DELIVERY_JOURNAL,
      useFactory: (
        deliveryLog: DeliveryLogService,
        deadLetter: PlatformDeadLetterService,
      ): OutboundDeliveryJournalPort => ({
        logDelivery: (input) => deliveryLog.logDelivery(input),
        saveDeadLetter: (input) => deadLetter.save(input),
      }),
      inject: [DeliveryLogService, PlatformDeadLetterService],
    },
    {
      provide: PlatformAgentToolsService,
      useFactory: (
        configService: ConfigService,
        goalsService: WispaceGoalsService,
        calendarService: WispaceCalendarService,
        exerciseClient: PrecreateExerciseApiClient,
        rescheduleConfirmationService: RescheduleConfirmationService<string>,
        outboundService: ZaloOutboundPort,
        accountLinkService: ZaloAccountLinkService,
        metrics: BotMetricsService,
        cache: WispaceDataCache,
        budgetService: PlatformWriteToolBudgetService,
      ) => {
        const appId = configService.get<string>('ZALO_APP_ID');
        const redirectUri = configService.get<string>(
          'ZALO_OAUTH_REDIRECT_URI',
        );
        const oauthAuthorizeUrl =
          appId && redirectUri
            ? `https://oauth.zaloapp.com/v4/permission?app_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}`
            : '';

        return new PlatformAgentToolsService(
          new ZaloGoalsCapabilityAdapter(goalsService, cache),
          new ZaloCalendarCapabilityAdapter(calendarService, cache),
          rescheduleConfirmationService,
          {
            platform: 'zalo',
            getNotLinkedMessage: () => {
              const linkPart = oauthAuthorizeUrl
                ? `\n\nLiên kết tài khoản tại đây: ${oauthAuthorizeUrl}`
                : '';
              return `${NOT_LINKED_MESSAGE}${linkPart}`;
            },
            // WISPACE expects the inbound Zalo OA user ID in x-zaloid; the
            // internal WISPACE userId (ctx.userId) stays for local DB ops only.
            wispaceExternalId: (ctx) => ctx.externalUserId,
            registerReportMessage: REGISTER_REPORT_MESSAGE,
            currentIdentityProvider: (externalUserId) =>
              accountLinkService.findCurrentIdentity(externalUserId),
            policyDeniedInc: (toolName, reason) =>
              metrics.incLlmToolPolicyDenied(toolName, 'zalo', reason),
            writeToolBudget: budgetService,
            writeToolPerMessageCaps: budgetService.perMessageCaps(),
            writeToolBudgetDeniedInc: (tool, reason) =>
              metrics.incWriteToolBudgetDenied(tool, 'zalo', reason),
            cacheInvalidation: new ZaloWispaceCacheInvalidationAdapter(cache),
            reschedule: {
              validateDateAndTime: false,
              messages: {
                calendarIdRequired: 'calendarId (số nguyên dương) là bắt buộc.',
                schedulingModeInvalid:
                  'schedulingMode (default_next_day_same_time hoặc explicit) là bắt buộc.',
                newLocalDateInvalid: '',
                newTimeInvalid: '',
              },
              confirmSender: async (
                externalUserId,
                summary,
                confirmationToken,
                userId,
              ) => {
                const outcome = await outboundService.sendText(
                  externalUserId,
                  `${summary}${RESCHEDULE_CONFIRM_SUFFIX} Mã: ${confirmationToken}`,
                  userId === undefined ? undefined : { userId },
                );
                if (outcome !== 'sent') {
                  throw new Error('Reschedule confirmation delivery failed');
                }
              },
            },
          },
          new ZaloExerciseCapabilityAdapter(exerciseClient, 'x-zaloid'),
        );
      },
      inject: [
        ConfigService,
        WispaceGoalsService,
        WispaceCalendarService,
        PrecreateExerciseApiClient,
        RescheduleConfirmationService,
        ZALO_OUTBOUND,
        ZaloAccountLinkService,
        BotMetricsService,
        WispaceDataCache,
        PlatformWriteToolBudgetService,
      ],
    },
    {
      provide: ZALO_AGENT_OPTIONS,
      useFactory: (
        configService: ConfigService,
        metrics: BotMetricsService,
        clarificationStore: ClarificationStateStore,
        adapter: LlmProviderAdapter,
        executionPort: LlmExecutionPort,
        accountLinkService: ZaloAccountLinkService,
        rescheduleConfirmationService: RescheduleConfirmationService<string>,
      ): PlatformChatAgentDynamicOptions => {
        const classifierConfig = buildClassifierConfig((key) =>
          configService.get<string>(key)?.trim(),
        );
        const classifierModel = resolveClassifierModel({
          ...classifierConfig,
          executionEnabled: readEnvBoolean(
            configService,
            'LLM_EXECUTION_ENABLED',
            true,
          ),
        });
        const contentClassifier = new LlmContentClassifier({
          adapter,
          execution: executionPort,
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
          onInputShape: (shape) => metrics.incClassifierInput(shape, 'zalo'),
          logger: new Logger('LlmContentClassifier'),
        });
        return {
          currentIdentityProvider: (externalUserId) =>
            accountLinkService.findCurrentIdentity(externalUserId),
          metrics: {
            timeLlmCall: (feature, model, round, fn) =>
              metrics.timeLlmCall(feature, model, round, fn),
            timeTool: (toolName, fn) => metrics.timeTool(toolName, fn),
            llmRoundOutcomeInc: (feature, outcome) =>
              metrics.incRoundOutcome(feature, outcome),
            observationOutcomeInc: (toolName, outcome) =>
              metrics.incObservationOutcome(toolName, 'zalo', outcome),
            toolPolicyDeniedInc: (toolName, reason) =>
              metrics.incLlmToolPolicyDenied(toolName, 'zalo', reason),
            degradedModeInc: (event) => metrics.incLlmDegradedMode(event),
            promptCanaryHitInc: () => metrics.incLlmPromptCanaryHit('zalo'),
            totalProviderAttemptsInc: (feature, attempts, outcome) =>
              metrics.incLlmTotalProviderAttempts(feature, attempts, outcome),
            classifierVerdictInc: (label, mode) =>
              metrics.incClassifierVerdict(label, mode, 'zalo'),
          },
          clarificationStore,
          clarificationOutcomeInc: (outcome) =>
            metrics.incClarificationOutcome(outcome),
          contentClassifier,
          classifierUsage: {
            provider: adapter.providerName,
            model: classifierModel,
          },
          llmExecution: executionPort,
          // Bounded admission telemetry (#389)
          llmAdmissionMetrics: metrics.llmAdmission,
          // The learner-profile part is the factory's; Zalo has no other.
          systemPromptSuffix: null,
          onBeforeReply: null,
          tryFastReschedule: null,
          cancelPendingReschedule: (externalUserId, approvalToken) =>
            rescheduleConfirmationService.cancelForUser(
              externalUserId,
              approvalToken,
            ),
        };
      },
      inject: [
        ConfigService,
        BotMetricsService,
        CLARIFICATION_STATE_STORE,
        'LLM_PROVIDER_ADAPTER',
        'LLM_EXECUTION_PORT',
        ZaloAccountLinkService,
        RescheduleConfirmationService,
      ],
    },
    ...createPlatformChatProviders({
      platform: 'zalo',
      // Zalo prefixes its chat-history env with its own namespace.
      historyEnvPrefix: 'ZALO_CHAT_HISTORY_',
      historyKeyPrefix: 'chat-history:zalo:',
      promptDir: join(__dirname, '../../shared/prompts'),
      promptFile: 'zalo-chat.system.txt',
      toolExecutionTimeoutMs: 35_000,
      appendHistory: true,
      queueWorkerReady: PLATFORM_CHAT_QUEUE_STORE,
      queueWorkerFlush: PlatformChatQueueService,
      agentDynamicOptions: ZALO_AGENT_OPTIONS,
    }),
    {
      provide: PlatformChatQueueService,
      useFactory: (
        configService: ConfigService,
        runtimeConfig: ChatRuntimeConfig,
        rateLimitService: PlatformChatRateLimitService,
        historyService: PlatformChatHistoryService,
        agentService: PlatformAgentService,
        outboundService: ZaloOutboundPort,
        queueStore: ChatQueueStorePort,
        accountLinkService: ZaloAccountLinkService,
        metrics: BotMetricsService,
      ) => {
        const adapters = createChatPipelineAdapters(
          rateLimitService,
          historyService,
          agentService,
          outboundService,
        );
        return new PlatformChatQueueService(
          configService,
          adapters.rateLimiter,
          adapters.history,
          adapters.agent,
          adapters.outbound,
          {
            sendText: async (externalUserId, text, options) => {
              await outboundService.sendText(externalUserId, text, {
                ...(options?.userId === undefined
                  ? {}
                  : { userId: options.userId }),
              });
            },
          },
          {
            // #397: fresh-mapping revalidation before pipeline flush
            freshMappingProvider: (externalUserId) =>
              accountLinkService.findMappingStateByZaloId(externalUserId),
            clarificationStateClearer: (externalUserId) =>
              agentService.clearClarificationState(externalUserId),
            clarificationDeliveryFailure: (externalUserId, eventId) =>
              agentService.markClarificationDeliveryFailedForEvent(
                externalUserId,
                eventId,
              ),
            clarificationOutcomeInc: (outcome) =>
              metrics.incClarificationOutcome(outcome),
            // #371: `chat_total` step timing feeds the chat-availability SLO.
            timeStep: (step, fn) => metrics.timeStep(step, fn),
          },
          queueStore,
          runtimeConfig,
        );
      },
      inject: [
        ConfigService,
        ChatRuntimeConfig,
        PlatformChatRateLimitService,
        PlatformChatHistoryService,
        PlatformAgentService,
        ZALO_OUTBOUND,
        PLATFORM_CHAT_QUEUE_STORE,
        ZaloAccountLinkService,
        BotMetricsService,
      ],
    },
    {
      // #1088: the chat service depends on the queue seam, not the concrete
      // adapter. The queue itself stays available for its own consumers.
      provide: ZALO_CHAT_QUEUE,
      useExisting: PlatformChatQueueService,
    },
    {
      provide: PLATFORM_CHAT_QUEUE_STORE,
      useFactory: (
        redisClient: import('@wispace/bot-common/redis').RedisClientPort,
        configService: ConfigService,
        runtimeConfig: ChatRuntimeConfig,
        metrics: BotMetricsService,
      ) =>
        new RedisChatQueueStore(
          redisClient,
          configService,
          {
            platform: 'zalo',
            onRecoveryOutcome: (outcome) =>
              metrics.incChatFlushRecovery('zalo', outcome),
            onReconciliation: (result) =>
              recordChatQueueReconciliationMetrics(metrics, result),
          },
          runtimeConfig,
        ),
      inject: [
        REDIS_CLIENT,
        ConfigService,
        ChatRuntimeConfig,
        BotMetricsService,
      ],
    },
    {
      provide: PlatformStudyCalendarCommandService,
      useFactory: (
        calendarService: WispaceCalendarService,
        configService: WispaceConfigService,
      ) =>
        new PlatformStudyCalendarCommandService(
          { platform: 'zalo' },
          calendarService,
          configService,
        ),
      inject: [WispaceCalendarService, WispaceConfigService],
    },
    {
      provide: 'ZaloCalendarPort',
      useFactory: (
        calendarService: WispaceCalendarService,
      ): CalendarPort<string> => ({
        listUpcomingEntries: async (
          zaloUserId: string,
          _userId: number,
          options?: { signal?: AbortSignal },
        ) => {
          const records = options
            ? await calendarService.listCalendars(zaloUserId, options)
            : await calendarService.listCalendars(zaloUserId);
          return records.map((record) => ({
            calendarId: record.id,
            scheduledTimeLabel:
              `${record.eventDate} ${record.time ?? ''}`.trim(),
            ownerUserId: record.userId,
          }));
        },
      }),
      inject: [WispaceCalendarService],
    },
    {
      provide: 'ZaloReschedulePort',
      useFactory: (
        studyCalendarCommandService: PlatformStudyCalendarCommandService,
      ): ReschedulePort<string> => ({
        rescheduleSession: (params) =>
          studyCalendarCommandService.rescheduleSession({
            externalUserId: params.externalId,
            userId: params.userId,
            calendarId: params.calendarId,
            schedulingMode: params.schedulingMode,
            newLocalDate: params.newLocalDate,
            newTime: params.newTime,
          }),
      }),
      inject: [PlatformStudyCalendarCommandService],
    },
    ...createRescheduleProviders('zalo'),
    {
      // #1507: Zalo override of the shared recovery cron, adding the transport
      // that re-sends a confirmation whose delivery was deferred. Without it, a
      // `deferred` Zalo row has no bot that can legitimately deliver it, and the
      // messenger pod would send a Zalo id to Meta and burn all five attempts.
      // Declared after createRescheduleProviders so it replaces that instance.
      provide: RescheduleRecoveryCronService,
      useFactory: (
        store: TypeormRescheduleStore<string>,
        metrics: BotMetricsService,
        pgLock: PgAdvisoryLockService,
        attemptStore: TypeormRescheduleAttemptStore,
        outbound: ZaloOutboundService,
      ) =>
        new RescheduleRecoveryCronService(
          store,
          metrics,
          { pgLock, lockId: ADVISORY_LOCKS.RESCHEDULE_RECOVERY },
          attemptStore,
          {
            deliver: ({ externalId, scheduledTimeLabel, userId }) =>
              outbound.sendText(
                externalId,
                `Mình đã dời buổi học sang ${scheduledTimeLabel} cho bạn rồi nhé ✅`,
                { userId },
              ),
          },
        ),
      inject: [
        TypeormRescheduleStore,
        BotMetricsService,
        PgAdvisoryLockService,
        TypeormRescheduleAttemptStore,
        ZaloOutboundService,
      ],
    },
    {
      provide: RescheduleConfirmationService,
      useFactory: (
        calendar: CalendarPort<string>,
        reschedule: ReschedulePort<string>,
        store: TypeormRescheduleStore<string>,
        cache: WispaceDataCache,
        budgetService: PlatformWriteToolBudgetService,
        metrics: BotMetricsService,
        attemptStore: TypeormRescheduleAttemptStore,
      ) =>
        new RescheduleConfirmationService<string>(calendar, reschedule, store, {
          attemptStore,
          consumeRescheduleBudget: (userId, externalId) =>
            budgetService.consumeDaily(
              String(externalId),
              userId,
              'reschedule_study_session',
            ),
          refundRescheduleBudget: (userId) =>
            budgetService.refundDaily(userId, 'reschedule_study_session'),
          rescheduleBudgetExceededMessage: buildWriteToolDailyBudgetMessage(
            'reschedule_study_session',
          ),
          calendarCacheInvalidation: new ZaloWispaceCacheInvalidationAdapter(
            cache,
          ),
          scopeFailureInc: (reason) =>
            metrics.incLlmToolPolicyDenied(
              'reschedule_study_session',
              'zalo',
              reason,
            ),
        }),
      inject: [
        'ZaloCalendarPort',
        'ZaloReschedulePort',
        TypeormRescheduleStore,
        WispaceDataCache,
        PlatformWriteToolBudgetService,
        BotMetricsService,
        TypeormRescheduleAttemptStore,
      ],
    },
    ZaloSendApiAdapter,
    {
      provide: ZALO_OUTBOUND_TRANSPORT,
      useExisting: ZaloSendApiAdapter,
    },
    ZaloOutboundService,
    {
      provide: ZALO_OUTBOUND,
      useExisting: ZaloOutboundService,
    },
    CleanupCronService,
    {
      provide: PlatformLinkAuditCleanupService,
      useFactory: (cleanupCron: CleanupCronService, dataSource: DataSource) =>
        new PlatformLinkAuditCleanupService(cleanupCron, dataSource, {
          platform: 'zalo',
          advisoryLockId: ADVISORY_LOCKS.PLATFORM_LINK_AUDIT_CLEANUP,
        }),
      inject: [CleanupCronService, DataSource],
    },
    LlmSafetyCleanupService,
    {
      provide: PlatformDeadLetterCronService,
      useFactory: (
        deadLetterService: PlatformDeadLetterService,
        configService: ConfigService,
        outboundService: ZaloOutboundPort,
        pgLock: PgAdvisoryLockService,
        metrics: BotMetricsService,
      ) =>
        new PlatformDeadLetterCronService(
          deadLetterService,
          configService,
          pgLock,
          {
            lockId: ADVISORY_LOCKS.ZALO_DEAD_LETTER_RETRY,
            extractPayload: (payload) => ({
              externalUserId: payload.zaloUserId as string | undefined,
              text: payload.text as string | undefined,
            }),
            abandonReason: 'Missing zaloUserId or text in payload',
            retryAmbiguous: false,
            cronName: 'zalo-dead-letter-retry',
            metrics,
            sendText: (externalUserId, text, opts) =>
              outboundService.sendTextForRetry(
                externalUserId,
                text,
                opts?.deliveryKey ?? '',
              ),
          },
        ),
      inject: [
        PlatformDeadLetterService,
        ConfigService,
        ZALO_OUTBOUND,
        PgAdvisoryLockService,
        BotMetricsService,
      ],
    },
    {
      provide: PlatformCleanupCronService,
      useFactory: (
        cleanupService: CleanupCronService,
        configService: ConfigService,
        dataSource: DataSource,
        oauthStateRepo: Repository<ZaloOauthStateEntity>,
        messageLogRepo: Repository<ZaloMessageLogEntity>,
        deadLetterRepo: Repository<WebhookDeadLetterEntity>,
        idempotencyRepo: Repository<ChatIdempotencyEntity>,
        reportClaimRepo: Repository<ScheduledReportClaimEntity>,
        rateLimitService: PlatformChatRateLimitService,
        metrics: BotMetricsService,
      ) =>
        new PlatformCleanupCronService(
          cleanupService,
          configService,
          dataSource,
          {
            platform: 'zalo',
            lockIds: {
              messageLog: ADVISORY_LOCKS.ZALO_CLEANUP_MESSAGE_LOG,
              deadLetter: ADVISORY_LOCKS.ZALO_CLEANUP_DEAD_LETTER,
              idempotencyRecovery:
                ADVISORY_LOCKS.ZALO_CLEANUP_IDEMPOTENCY_RECOVERY,
              idempotencyCleanup: ADVISORY_LOCKS.ZALO_CLEANUP_IDEMPOTENCY,
              oauthState: ADVISORY_LOCKS.ZALO_CLEANUP_OAUTH_STATE,
              reportClaim: ADVISORY_LOCKS.ZALO_CLEANUP_REPORT_CLAIM,
            },
            messageLogRepo,
            deadLetterRepo,
            idempotencyRepo,
            oauthStateRepo,
            reportClaimRepo,
            rateLimitService,
            metrics,
          },
        ),
      inject: [
        CleanupCronService,
        ConfigService,
        DataSource,
        getRepositoryToken(ZaloOauthStateEntity),
        getRepositoryToken(ZaloMessageLogEntity),
        getRepositoryToken(WebhookDeadLetterEntity),
        getRepositoryToken(ChatIdempotencyEntity),
        getRepositoryToken(ScheduledReportClaimEntity),
        PlatformChatRateLimitService,
        BotMetricsService,
      ],
    },
  ],
  exports: [
    'LLM_PROVIDER_ADAPTER',
    'LLM_ADMISSION_COORDINATOR',
    'LLM_EXECUTION_PORT',
    'LLM_REPORT_EXECUTION_PORT',
    PlatformAgentService,
    PlatformChatHistoryService,
    PlatformChatQueueService,
    ZaloChatService,
    ZaloWelcomeService,
    ZALO_OUTBOUND,
    ZaloOutboundService,
    PlatformDeadLetterService,
  ],
})
export class ZaloChatModule {}
