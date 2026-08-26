import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { join } from 'path';
import {
  CleanupCronService,
  PlatformCleanupCronService,
} from '@wispace/cleanup-cron';
import {
  ADVISORY_LOCKS,
  PgAdvisoryLockService,
} from '@wispace/bot-common/locks';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { REDIS_CLIENT } from '@wispace/bot-common/redis';
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
import { WispaceModule } from '../wispace/wispace.module';
import {
  PlatformAgentService,
  PlatformAgentToolsService,
  PlatformChatHistoryService,
  PlatformChatQueueService,
  RedisChatQueueStore,
  RedisChatQueueWorkerService,
  PLATFORM_CHAT_QUEUE_STORE,
  createChatPipelineAdapters,
} from '@wispace/chat-agent';
import type { ChatQueueStorePort } from '@wispace/chat-agent';
import type { LlmProviderAdapter } from '@wispace/llm-agent';
import {
  WispaceCalendarService,
  PrecreateExerciseApiClient,
  WispaceGoalsService,
} from '@wispace/wispace-client';
import {
  RescheduleConfirmationService,
  type CalendarPort,
  type ReschedulePort,
} from '@wispace/reschedule-confirm';
import { PlatformStudyCalendarCommandService } from '@wispace/study-reminder-shared';
import { DiscordMenuService } from './application/services/discord-menu.service';
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
    ]),
  ],
  providers: [
    DiscordChatGateway,
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
      ) =>
        new PlatformAgentToolsService(
          goalsService,
          calendarService,
          rescheduleConfirmationService,
          {
            getNotLinkedMessage: () => NOT_LINKED_MESSAGE,
            wispaceExternalId: (ctx) => ctx.externalUserId,
            registerReportMessage: REGISTER_REPORT_MESSAGE,
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
              confirmSender: (externalUserId, summary) =>
                outboundService.sendRescheduleConfirmation(
                  externalUserId,
                  summary,
                ),
            },
          },
          exerciseClient,
          'x-discordid',
        ),
      inject: [
        WispaceGoalsService,
        WispaceCalendarService,
        PrecreateExerciseApiClient,
        RescheduleConfirmationService,
        DiscordOutboundService,
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
            },
            // Bounded admission telemetry (#389)
            llmAdmissionMetrics: metrics.llmAdmission,
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
        LEARNER_PROFILE_STORE,
        BotMetricsService,
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
              accountLinkService.findUserIdByDiscordId(externalUserId),
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
      ],
    },
    {
      provide: PLATFORM_CHAT_QUEUE_STORE,
      useFactory: (
        redisClient: import('@wispace/bot-common/redis').RedisClientPort,
        configService: ConfigService,
      ) =>
        new RedisChatQueueStore(redisClient, configService, {
          platform: 'discord',
        }),
      inject: [REDIS_CLIENT, ConfigService],
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
      ) =>
        new RescheduleConfirmationService<string>(calendar, reschedule, store),
      inject: [
        'DiscordCalendarPort',
        'DiscordReschedulePort',
        TypeormRescheduleStore,
      ],
    },
    DiscordMenuService,
    CleanupCronService,
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
              reportClaim: 884_200_920,
            },
            messageLogRepo,
            deadLetterRepo,
            idempotencyRepo,
            reportClaimRepo,
            rateLimitService,
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
      ],
    },
  ],
  exports: [],
})
export class DiscordChatModule {}
