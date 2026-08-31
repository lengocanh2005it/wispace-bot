import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { join } from 'path';
import {
  CleanupCronService,
  PlatformCleanupCronService,
  PlatformLinkAuditCleanupService,
} from '@wispace/cleanup-cron';
import {
  ADVISORY_LOCKS,
  PgAdvisoryLockService,
} from '@wispace/bot-common/locks';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import { BotMetricsService } from '@wispace/bot-metrics';
import {
  ChatMeteringModule,
  PlatformChatRateLimitService,
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
  ChatIdempotencyEntity,
  LlmSafetyCleanupService,
} from '@wispace/chat-metering';
import { AccountLinkModule } from '../account-link/account-link.module';
import { DiscordAccountLinkService } from '@discord/modules/account-link/application/services/discord-account-link.service';
import { DiscordOauthStateEntity } from '../../infrastructure/database/entities/discord-oauth-state.entity';
import { WispaceModule } from '../wispace/wispace.module';
import {
  PlatformAgentService,
  PlatformAgentToolsService,
  PlatformChatHistoryService,
  PlatformChatQueueService,
  RedisChatQueueStore,
  RedisChatQueueWorkerService,
  PLATFORM_CHAT_QUEUE_STORE,
  CLARIFICATION_STATE_STORE,
  createChatPipelineAdapters,
} from '@wispace/chat-agent';
import type {
  ChatQueueStorePort,
  ClarificationStateStore,
} from '@wispace/chat-agent';
import type { LlmProviderAdapter } from '@wispace/llm-agent';
import {
  WispaceCalendarService,
  PrecreateExerciseApiClient,
  WispaceGoalsService,
  WispaceDataCache,
} from '@wispace/wispace-client';
import {
  DiscordCalendarCapabilityAdapter,
  DiscordExerciseCapabilityAdapter,
  DiscordGoalsCapabilityAdapter,
  DiscordWispaceCacheInvalidationAdapter,
} from './infrastructure/adapters/discord-wispace-capability.adapters';
import {
  RescheduleConfirmationService,
  type CalendarPort,
  type ReschedulePort,
} from '@wispace/reschedule-confirm';
import {
  PlatformStudyCalendarCommandService,
  StudyReminderJobEntity,
  TypeormStudyReminderJobRepository,
  STUDY_REMINDER_JOB_REPOSITORY,
} from '@wispace/study-reminder-shared';
import { DiscordMenuService } from './application/services/discord-menu.service';
import { DiscordConsentService } from './application/services/discord-consent.service';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { DiscordOutboundModule } from './discord-outbound.module';
import { DiscordSharedModule } from './discord-shared.module';
import { DiscordChatGateway } from './presentation/gateways/discord-chat.gateway';
import {
  PlatformDeadLetterCronService,
  PlatformDeadLetterService,
  WebhookDeadLetterEntity,
  ReportSendJobEntity,
  ScheduledReportClaimEntity,
  RescheduleConfirmationEntity,
  RescheduleRecoveryCronService,
  LearnerProfileEntity,
  TypeormRescheduleStore,
} from '@wispace/database';
import {
  LEARNER_PROFILE_STORE,
  TypeOrmLearnerProfileStore,
  createLearnerProfileRecorder,
  createLearnerProfileSuffix,
} from '@wispace/learner-profile';
import type { LearnerProfileStorePort } from '@wispace/learner-profile';
import { DiscordMessageLogEntity } from '../../infrastructure/database/entities/discord-message-log.entity';
import { DiscordOutboundService } from './application/services/discord-outbound.service';

const NOT_LINKED_MESSAGE =
  'Bạn chưa liên kết tài khoản WISPACE với Discord. Vào WISPACE để lấy link "Kết nối Discord" rồi thử lại nhé.';

const REGISTER_REPORT_MESSAGE =
  'Báo cáo học tập là tự động — WISPACE gửi báo cáo AI qua Discord vào mỗi buổi sáng, khoảng 2–3 ngày trước ngày thi bạn sẽ nhận được báo cáo chi tiết. Bạn không cần đăng ký riêng.';

@Module({
  imports: [
    BotCommonModule,
    DatabaseModule,
    ChatMeteringModule.forPlatform('discord', {
      requireEnv: true,
      lenientEnabledCheck: true,
    }),
    DiscordOutboundModule,
    DiscordSharedModule,
    AccountLinkModule,
    WispaceModule,
    TypeOrmModule.forFeature([
      WebhookDeadLetterEntity,
      DiscordMessageLogEntity,
      ReportSendJobEntity,
      ChatIdempotencyEntity,
      ScheduledReportClaimEntity,
      RescheduleConfirmationEntity,
      LearnerProfileEntity,
      DiscordOauthStateEntity,
      StudyReminderJobEntity,
    ]),
  ],
  providers: [
    DiscordChatGateway,
    DiscordConsentService,
    TypeormStudyReminderJobRepository,
    {
      provide: STUDY_REMINDER_JOB_REPOSITORY,
      useExisting: TypeormStudyReminderJobRepository,
    },
    {
      provide: PlatformChatHistoryService,
      useFactory: (
        configService: ConfigService,
        redisClient?: { getNativeClient(): unknown } | null,
      ) =>
        new PlatformChatHistoryService(
          configService,
          { envPrefix: 'CHAT_HISTORY_', keyPrefix: 'chat-history:discord:' },
          redisClient,
        ),
      inject: [ConfigService, { token: REDIS_CLIENT, optional: true }],
    },
    {
      provide: PlatformAgentToolsService,
      useFactory: (
        goalsService: WispaceGoalsService,
        calendarService: WispaceCalendarService,
        exerciseClient: PrecreateExerciseApiClient,
        rescheduleConfirmationService: RescheduleConfirmationService<string>,
        outboundService: DiscordOutboundService,
        accountLinkService: DiscordAccountLinkService,
        metrics: BotMetricsService,
        cache: WispaceDataCache,
      ) =>
        new PlatformAgentToolsService(
          new DiscordGoalsCapabilityAdapter(goalsService, cache),
          new DiscordCalendarCapabilityAdapter(calendarService, cache),
          rescheduleConfirmationService,
          {
            platform: 'discord',
            getNotLinkedMessage: () => NOT_LINKED_MESSAGE,
            wispaceExternalId: (ctx) => ctx.externalUserId,
            registerReportMessage: REGISTER_REPORT_MESSAGE,
            currentIdentityProvider: (externalUserId) =>
              accountLinkService.findCurrentIdentity(externalUserId),
            policyDeniedInc: (toolName, reason) =>
              metrics.incLlmToolPolicyDenied(toolName, 'discord', reason),
            cacheInvalidation: new DiscordWispaceCacheInvalidationAdapter(
              cache,
            ),
            reschedule: {
              validateDateAndTime: true,
              messages: {
                calendarIdRequired: 'calendarId is required',
                schedulingModeInvalid:
                  'schedulingMode must be default_next_day_same_time or explicit',
                newLocalDateInvalid:
                  'newLocalDate must be in YYYY-MM-DD format',
                newTimeInvalid: 'newTime must be in HH:MM format',
              },
              confirmSender: (externalUserId, summary, confirmationToken) =>
                outboundService.sendRescheduleConfirmation(
                  externalUserId,
                  summary,
                  confirmationToken,
                ),
            },
          },
          new DiscordExerciseCapabilityAdapter(exerciseClient, 'x-discordid'),
        ),
      inject: [
        WispaceGoalsService,
        WispaceCalendarService,
        PrecreateExerciseApiClient,
        RescheduleConfirmationService,
        DiscordOutboundService,
        DiscordAccountLinkService,
        BotMetricsService,
        WispaceDataCache,
      ],
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
        learnerProfileStore: LearnerProfileStorePort,
        metrics: BotMetricsService,
        redisClient: RedisClientPort,
        clarificationStore: ClarificationStateStore,
        accountLinkService: DiscordAccountLinkService,
      ) => {
        const learnerProfileSuffix = createLearnerProfileSuffix(
          learnerProfileStore,
          'discord',
        );
        return new PlatformAgentService(
          configService,
          toolsService,
          historyService,
          usageRecorder,
          safetyEventService,
          adapter,
          {
            platform: 'discord',
            currentIdentityProvider: (externalUserId) =>
              accountLinkService.findCurrentIdentity(externalUserId),
            clarificationStore,
            promptDir: join(__dirname, '../../shared/prompts'),
            promptFile: 'discord-chat.system.txt',
            // Single retry layer — retryWithBackoff in PlatformAgentService
            maxLlmRetries: 0,
            toolExecutionTimeoutMs: 35_000,
            systemPromptSuffix: learnerProfileSuffix,
            // Learner profile (#207 item 3): persist server-derived facts
            // (band target, exam date) from successful tool results.
            onToolResult: createLearnerProfileRecorder(
              learnerProfileStore,
              'discord',
            ),
            metrics: {
              timeLlmCall: (feature, model, round, fn) =>
                metrics.timeLlmCall(feature, model, round, fn),
              timeTool: (toolName, fn) => metrics.timeTool(toolName, fn),
              llmRoundOutcomeInc: (feature, outcome) =>
                metrics.incRoundOutcome(feature, outcome),
              observationOutcomeInc: (toolName, outcome) =>
                metrics.incObservationOutcome(toolName, 'discord', outcome),
              toolPolicyDeniedInc: (toolName, reason) =>
                metrics.incLlmToolPolicyDenied(toolName, 'discord', reason),
              degradedModeInc: (event) => metrics.incLlmDegradedMode(event),
            },
            clarificationOutcomeInc: (outcome) =>
              metrics.incClarificationOutcome(outcome),
            // Bounded admission telemetry (#389)
            llmAdmissionMetrics: metrics.llmAdmission,
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
        LEARNER_PROFILE_STORE,
        BotMetricsService,
        REDIS_CLIENT,
        CLARIFICATION_STATE_STORE,
        DiscordAccountLinkService,
      ],
    },
    {
      provide: PlatformChatQueueService,
      useFactory: (
        configService: ConfigService,
        rateLimitService: PlatformChatRateLimitService,
        historyService: PlatformChatHistoryService,
        agentService: PlatformAgentService,
        outboundService: DiscordOutboundService,
        queueStore: ChatQueueStorePort,
        accountLinkService: DiscordAccountLinkService,
        metrics: BotMetricsService,
      ) => {
        const adapters = createChatPipelineAdapters(
          rateLimitService,
          historyService,
          agentService,
          outboundService,
          { isServerChannel: true },
        );
        return new PlatformChatQueueService(
          configService,
          adapters.rateLimiter,
          adapters.history,
          adapters.agent,
          adapters.outbound,
          outboundService,
          {
            mergedTextMaxChars: Math.max(
              1,
              Number(configService.get<string>('CHAT_MERGED_TEXT_MAX_CHARS')) ||
                4000,
            ),
            typingIndicator: (externalUserId) =>
              outboundService.sendTyping(externalUserId),
            propagateServerChannel: true,
            // #397: fresh-mapping revalidation before pipeline flush
            freshMappingProvider: (externalUserId) =>
              accountLinkService.findMappingStateByDiscordId(externalUserId),
            clarificationStateClearer: (externalUserId) =>
              agentService.clearClarificationState(externalUserId),
            clarificationDeliveryFailure: (externalUserId, eventId) =>
              agentService.markClarificationDeliveryFailedForEvent(
                externalUserId,
                eventId,
              ),
            clarificationOutcomeInc: (outcome) =>
              metrics.incClarificationOutcome(outcome),
          },
          queueStore,
        );
      },
      inject: [
        ConfigService,
        PlatformChatRateLimitService,
        PlatformChatHistoryService,
        PlatformAgentService,
        DiscordOutboundService,
        PLATFORM_CHAT_QUEUE_STORE,
        DiscordAccountLinkService,
        BotMetricsService,
      ],
    },
    {
      provide: PLATFORM_CHAT_QUEUE_STORE,
      useFactory: (
        redisClient: import('@wispace/bot-common/redis').RedisClientPort,
        configService: ConfigService,
        metrics: BotMetricsService,
      ) =>
        new RedisChatQueueStore(redisClient, configService, {
          platform: 'discord',
          onRecoveryOutcome: (outcome) =>
            metrics.incChatFlushRecovery('discord', outcome),
        }),
      inject: [REDIS_CLIENT, ConfigService, BotMetricsService],
    },
    {
      provide: RedisChatQueueWorkerService,
      useFactory: (
        configService: ConfigService,
        queueStore: ChatQueueStorePort,
        queueService: PlatformChatQueueService,
      ) =>
        new RedisChatQueueWorkerService(
          configService,
          (limit) => queueStore.listReadyExternalUserIds(limit),
          (externalUserId) => queueService.flushReady(externalUserId),
        ),
      inject: [
        ConfigService,
        PLATFORM_CHAT_QUEUE_STORE,
        PlatformChatQueueService,
      ],
    },
    {
      provide: 'DiscordCalendarPort',
      useFactory: (
        studyCalendarCommandService: PlatformStudyCalendarCommandService,
      ): CalendarPort<string> => ({
        listUpcomingEntries: (externalId: string, _userId: number) =>
          studyCalendarCommandService
            .listEntries(externalId, { timeRange: 'upcoming' })
            .then((result) =>
              result.entries.map((entry) => ({
                calendarId: entry.calendarId,
                scheduledTimeLabel: entry.scheduledTimeLabel,
              })),
            ),
      }),
      inject: [PlatformStudyCalendarCommandService],
    },
    {
      provide: 'DiscordReschedulePort',
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
    {
      provide: TypeormRescheduleStore,
      useFactory: (repo: Repository<RescheduleConfirmationEntity>) =>
        new TypeormRescheduleStore<string>('discord', repo),
      inject: [getRepositoryToken(RescheduleConfirmationEntity)],
    },
    RescheduleRecoveryCronService,
    {
      provide: RescheduleConfirmationService,
      useFactory: (
        calendar: CalendarPort<string>,
        reschedule: ReschedulePort<string>,
        store: TypeormRescheduleStore<string>,
        cache: WispaceDataCache,
      ) =>
        new RescheduleConfirmationService<string>(calendar, reschedule, store, {
          // The calendar write commits here — drop cached reads for the user
          // so the next "upcoming sessions" question re-fetches (#636).
          onConfirmed: (externalId) =>
            new DiscordWispaceCacheInvalidationAdapter(
              cache,
            ).invalidateCalendar(externalId),
        }),
      inject: [
        'DiscordCalendarPort',
        'DiscordReschedulePort',
        TypeormRescheduleStore,
        WispaceDataCache,
      ],
    },
    DiscordMenuService,
    CleanupCronService,
    {
      provide: PlatformLinkAuditCleanupService,
      useFactory: (
        cleanupCron: CleanupCronService,
        configService: ConfigService,
        dataSource: DataSource,
      ) =>
        new PlatformLinkAuditCleanupService(
          cleanupCron,
          configService,
          dataSource,
          { platform: 'discord', advisoryLockId: 884_200_942 },
        ),
      inject: [CleanupCronService, ConfigService, DataSource],
    },
    LlmSafetyCleanupService,
    {
      provide: PlatformDeadLetterCronService,
      useFactory: (
        deadLetterService: PlatformDeadLetterService,
        configService: ConfigService,
        outboundService: DiscordOutboundService,
        pgLock: PgAdvisoryLockService,
      ) =>
        new PlatformDeadLetterCronService(
          deadLetterService,
          configService,
          pgLock,
          {
            lockId: ADVISORY_LOCKS.DISCORD_DEAD_LETTER_RETRY,
            extractPayload: (payload) => ({
              externalUserId: payload.discordUserId as string | undefined,
              text: payload.text as string | undefined,
            }),
            abandonReason: 'Missing discordUserId or text in payload',
            retryAmbiguous: true,
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
        DiscordOutboundService,
        PgAdvisoryLockService,
      ],
    },
    {
      provide: PlatformCleanupCronService,
      useFactory: (
        cleanupService: CleanupCronService,
        configService: ConfigService,
        dataSource: DataSource,
        messageLogRepo: Repository<DiscordMessageLogEntity>,
        deadLetterRepo: Repository<WebhookDeadLetterEntity>,
        idempotencyRepo: Repository<ChatIdempotencyEntity>,
        reportClaimRepo: Repository<ScheduledReportClaimEntity>,
        rateLimitService: PlatformChatRateLimitService,
        oauthStateRepo: Repository<DiscordOauthStateEntity>,
      ) =>
        new PlatformCleanupCronService(
          cleanupService,
          configService,
          dataSource,
          {
            platform: 'discord',
            envPrefix: 'DISCORD_',
            lockIds: {
              messageLog: 884_200_911,
              deadLetter: 884_200_912,
              idempotencyRecovery: 884_200_914,
              idempotencyCleanup: 884_200_915,
              oauthState: 884_200_939,
              reportClaim: 884_200_920,
            },
            messageLogRepo,
            deadLetterRepo,
            idempotencyRepo,
            reportClaimRepo,
            rateLimitService,
            oauthStateRepo,
          },
        ),
      inject: [
        CleanupCronService,
        ConfigService,
        DataSource,
        getRepositoryToken(DiscordMessageLogEntity),
        getRepositoryToken(WebhookDeadLetterEntity),
        getRepositoryToken(ChatIdempotencyEntity),
        getRepositoryToken(ScheduledReportClaimEntity),
        PlatformChatRateLimitService,
        getRepositoryToken(DiscordOauthStateEntity),
      ],
    },
  ],
  exports: [
    PlatformAgentService,
    PlatformChatHistoryService,
    PlatformChatQueueService,
  ],
})
export class DiscordChatModule {}
