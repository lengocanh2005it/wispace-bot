import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import {
  createLlmProviderAdapterFromEnv,
  type LlmProviderAdapter,
} from '@wispace/llm-agent';
import {
  ChatMeteringModule,
  ChatIdempotencyEntity,
  PlatformChatRateLimitService,
  PlatformLlmUsageRecorderAdapter,
  PlatformLlmSafetyEventAdapter,
  LlmSafetyCleanupService,
} from '@wispace/chat-metering';
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
import {
  WispaceCalendarService,
  WispaceConfigService,
  PrecreateExerciseApiClient,
  WispaceGoalsService,
} from '@wispace/wispace-client';
import {
  ADVISORY_LOCKS,
  PgAdvisoryLockService,
} from '@wispace/bot-common/locks';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import { BotMetricsService } from '@wispace/bot-metrics';
import { ZaloOauthModule } from '../zalo-oauth/zalo-oauth.module';
import { ZaloAccountLinkService } from '@zalo/modules/zalo-oauth/application/services/zalo-account-link.service';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { ZaloOutboundService } from './application/services/zalo-outbound.service';
import { ZaloChatService } from './application/services/zalo-chat.service';
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
import {
  PlatformDeadLetterCronService,
  PlatformDeadLetterService,
  WebhookDeadLetterEntity,
  DeliveryLogService,
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
import {
  CleanupCronService,
  PlatformCleanupCronService,
  PlatformLinkAuditCleanupService,
} from '@wispace/cleanup-cron';
import { ZaloMessageLogEntity } from '../../infrastructure/database/entities/zalo-message-log.entity';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

const NOT_LINKED_MESSAGE =
  'Bạn chưa liên kết tài khoản WISPACE với Zalo. Liên kết tài khoản để sử dụng tính năng này nhé.';

const REGISTER_REPORT_MESSAGE =
  'Bạn đã được đăng ký nhận báo cáo học tập qua Zalo mỗi sáng lúc 08:00 (không cần đăng ký riêng).';

const RESCHEDULE_CONFIRM_SUFFIX =
  '\n\nReply "xác nhận" để đồng ý, hoặc "hủy" để hủy.';

@Module({
  imports: [
    BotCommonModule,
    DatabaseModule,
    ZaloOauthModule,
    ZaloWispaceModule,
    ChatMeteringModule.forPlatform('zalo'),
    TypeOrmModule.forFeature([
      ChatIdempotencyEntity,
      ZaloMessageLogEntity,
      WebhookDeadLetterEntity,
      ZaloOauthStateEntity,
      ScheduledReportClaimEntity,
      RescheduleConfirmationEntity,
      LearnerProfileEntity,
      StudyReminderJobEntity,
    ]),
  ],
  providers: [
    ZaloChatService,
    TypeormStudyReminderJobRepository,
    {
      provide: STUDY_REMINDER_JOB_REPOSITORY,
      useExisting: TypeormStudyReminderJobRepository,
    },
    {
      provide: 'LLM_PROVIDER_ADAPTER',
      useFactory: (configService: ConfigService): LlmProviderAdapter =>
        createLlmProviderAdapterFromEnv((key) =>
          configService.get<string>(key)?.trim(),
        ),
      inject: [ConfigService],
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
      provide: PlatformChatHistoryService,
      useFactory: (
        configService: ConfigService,
        redisClient?: { getNativeClient(): unknown } | null,
      ) =>
        new PlatformChatHistoryService(
          configService,
          { envPrefix: 'ZALO_CHAT_HISTORY_', keyPrefix: 'chat-history:zalo:' },
          redisClient,
        ),
      inject: [ConfigService, { token: REDIS_CLIENT, optional: true }],
    },
    {
      provide: PlatformAgentToolsService,
      useFactory: (
        configService: ConfigService,
        goalsService: WispaceGoalsService,
        calendarService: WispaceCalendarService,
        exerciseClient: PrecreateExerciseApiClient,
        rescheduleConfirmationService: RescheduleConfirmationService<string>,
        outboundService: ZaloOutboundService,
        accountLinkService: ZaloAccountLinkService,
        metrics: BotMetricsService,
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
          goalsService,
          calendarService,
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
            reschedule: {
              validateDateAndTime: false,
              messages: {
                calendarIdRequired: 'calendarId (số nguyên dương) là bắt buộc.',
                schedulingModeInvalid:
                  'schedulingMode (default_next_day_same_time hoặc explicit) là bắt buộc.',
                newLocalDateInvalid: '',
                newTimeInvalid: '',
              },
              confirmSender: (externalUserId, summary, confirmationToken) =>
                outboundService.sendText(
                  externalUserId,
                  `${summary}${RESCHEDULE_CONFIRM_SUFFIX}${confirmationToken ? ` Mã: ${confirmationToken}` : ''}`,
                ),
            },
          },
          exerciseClient,
          'x-zaloid',
        );
      },
      inject: [
        ConfigService,
        WispaceGoalsService,
        WispaceCalendarService,
        PrecreateExerciseApiClient,
        RescheduleConfirmationService,
        ZaloOutboundService,
        ZaloAccountLinkService,
        BotMetricsService,
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
        accountLinkService: ZaloAccountLinkService,
      ) => {
        const learnerProfileSuffix = createLearnerProfileSuffix(
          learnerProfileStore,
          'zalo',
        );
        return new PlatformAgentService(
          configService,
          toolsService,
          historyService,
          usageRecorder,
          safetyEventService,
          adapter,
          {
            platform: 'zalo',
            currentIdentityProvider: (externalUserId) =>
              accountLinkService.findCurrentIdentity(externalUserId),
            clarificationStore,
            promptDir: join(__dirname, '../../shared/prompts'),
            promptFile: 'zalo-chat.system.txt',
            // Single retry layer — retryWithBackoff in PlatformAgentService
            maxLlmRetries: 0,
            toolExecutionTimeoutMs: 35_000,
            systemPromptSuffix: learnerProfileSuffix,
            // Learner profile (#207 item 3): persist server-derived facts
            // (band target, exam date) from successful tool results.
            onToolResult: createLearnerProfileRecorder(
              learnerProfileStore,
              'zalo',
            ),
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
        ZaloAccountLinkService,
      ],
    },
    {
      provide: PlatformChatQueueService,
      useFactory: (
        configService: ConfigService,
        rateLimitService: PlatformChatRateLimitService,
        historyService: PlatformChatHistoryService,
        agentService: PlatformAgentService,
        outboundService: ZaloOutboundService,
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
          outboundService,
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
          },
          queueStore,
        );
      },
      inject: [
        ConfigService,
        PlatformChatRateLimitService,
        PlatformChatHistoryService,
        PlatformAgentService,
        ZaloOutboundService,
        PLATFORM_CHAT_QUEUE_STORE,
        ZaloAccountLinkService,
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
          platform: 'zalo',
          onRecoveryOutcome: (outcome) =>
            metrics.incChatFlushRecovery('zalo', outcome),
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
        listUpcomingEntries: async (zaloUserId: string) => {
          const records = await calendarService.listCalendars(zaloUserId);
          return records.map((record) => ({
            calendarId: record.id,
            scheduledTimeLabel:
              `${record.eventDate} ${record.time ?? ''}`.trim(),
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
    {
      provide: TypeormRescheduleStore,
      useFactory: (repo: Repository<RescheduleConfirmationEntity>) =>
        new TypeormRescheduleStore<string>('zalo', repo),
      inject: [getRepositoryToken(RescheduleConfirmationEntity)],
    },
    RescheduleRecoveryCronService,
    {
      provide: RescheduleConfirmationService,
      useFactory: (
        calendar: CalendarPort<string>,
        reschedule: ReschedulePort<string>,
        store: TypeormRescheduleStore<string>,
      ) =>
        new RescheduleConfirmationService<string>(calendar, reschedule, store),
      inject: [
        'ZaloCalendarPort',
        'ZaloReschedulePort',
        TypeormRescheduleStore,
      ],
    },
    ZaloOutboundService,
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
          { platform: 'zalo', advisoryLockId: 884_200_942 },
        ),
      inject: [CleanupCronService, ConfigService, DataSource],
    },
    LlmSafetyCleanupService,
    {
      provide: PlatformDeadLetterCronService,
      useFactory: (
        deadLetterService: PlatformDeadLetterService,
        configService: ConfigService,
        outboundService: ZaloOutboundService,
        pgLock: PgAdvisoryLockService,
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
        ZaloOutboundService,
        PgAdvisoryLockService,
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
      ) =>
        new PlatformCleanupCronService(
          cleanupService,
          configService,
          dataSource,
          {
            platform: 'zalo',
            envPrefix: 'ZALO_',
            lockIds: {
              messageLog: 884_200_916,
              deadLetter: 884_200_917,
              idempotencyRecovery: 884_200_918,
              idempotencyCleanup: 884_200_919,
              oauthState: 884_200_913,
              reportClaim: 884_200_921,
            },
            messageLogRepo,
            deadLetterRepo,
            idempotencyRepo,
            oauthStateRepo,
            reportClaimRepo,
            rateLimitService,
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
      ],
    },
  ],
  exports: [
    'LLM_PROVIDER_ADAPTER',
    PlatformAgentService,
    PlatformChatHistoryService,
    PlatformChatQueueService,
    ZaloChatService,
    ZaloOutboundService,
    PlatformDeadLetterService,
  ],
})
export class ZaloChatModule {}
