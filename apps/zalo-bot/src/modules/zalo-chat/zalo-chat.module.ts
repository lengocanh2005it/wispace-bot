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
} from '@wispace/chat-metering';
import {
  PlatformAgentService,
  PlatformAgentToolsService,
  PlatformChatHistoryService,
  PlatformChatQueueService,
  createChatPipelineAdapters,
} from '@wispace/chat-agent';
import {
  WispaceCalendarService,
  WispaceConfigService,
  WispaceExerciseService,
  WispaceGoalsService,
} from '@wispace/wispace-client';
import {
  ADVISORY_LOCKS,
  BotCommonModule,
  PgAdvisoryLockService,
  REDIS_CLIENT,
} from '@wispace/bot-common';
import { ZaloOauthModule } from '../zalo-oauth/zalo-oauth.module';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { ZaloOutboundService } from './application/services/zalo-outbound.service';
import { ZaloChatService } from './application/services/zalo-chat.service';
import {
  RescheduleConfirmationService,
  type CalendarPort,
  type ReschedulePort,
} from '@wispace/reschedule-confirm';
import { PlatformStudyCalendarCommandService } from '@wispace/study-reminder-shared';
import { ZaloCalendarPort } from './infrastructure/adapters/zalo-calendar.port';
import { ZaloReschedulePort } from './infrastructure/adapters/zalo-reschedule.port';
import {
  PlatformDeadLetterCronService,
  PlatformDeadLetterService,
  WebhookDeadLetterEntity,
  DeliveryLogService,
  ScheduledReportClaimEntity,
  RescheduleConfirmationEntity,
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
} from '@wispace/cleanup-cron';
import { ZaloMessageLogEntity } from '../../infrastructure/database/entities/zalo-message-log.entity';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

const NOT_LINKED_MESSAGE =
  'Bạn chưa liên kết tài khoản WISPACE với Zalo. Liên kết tài khoản để sử dụng tính năng này nhé.';

const REGISTER_REPORT_MESSAGE =
  'Bạn đã được đăng ký nhận báo cáo học tập qua Zalo mỗi sáng lúc 08:00 (không cần đăng ký riêng).';

const RESCHEDULE_CONFIRM_SUFFIX =
  '\n\nReply "xác nhận" để đồng ý, hoặc "hủy" để hủy.';

@Module({
  imports: [
    BotCommonModule,
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
    ]),
  ],
  providers: [
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
        exerciseService: WispaceExerciseService,
        rescheduleConfirmationService: RescheduleConfirmationService<string>,
        outboundService: ZaloOutboundService,
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
            reschedule: {
              validateDateAndTime: false,
              messages: {
                calendarIdRequired: 'calendarId (số nguyên dương) là bắt buộc.',
                schedulingModeInvalid:
                  'schedulingMode (default_next_day_same_time hoặc explicit) là bắt buộc.',
                newLocalDateInvalid: '',
                newTimeInvalid: '',
              },
              confirmSender: (externalUserId, summary) =>
                outboundService.sendText(
                  externalUserId,
                  `${summary}${RESCHEDULE_CONFIRM_SUFFIX}`,
                ),
            },
          },
          exerciseService,
        );
      },
      inject: [
        ConfigService,
        WispaceGoalsService,
        WispaceCalendarService,
        WispaceExerciseService,
        RescheduleConfirmationService,
        ZaloOutboundService,
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
        );
      },
      inject: [
        ConfigService,
        PlatformChatRateLimitService,
        PlatformChatHistoryService,
        PlatformAgentService,
        ZaloOutboundService,
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
    ZaloCalendarPort,
    ZaloReschedulePort,
    {
      provide: TypeormRescheduleStore,
      useFactory: (repo: Repository<RescheduleConfirmationEntity>) =>
        new TypeormRescheduleStore<string>('zalo', repo),
      inject: [getRepositoryToken(RescheduleConfirmationEntity)],
    },
    {
      provide: RescheduleConfirmationService,
      useFactory: (
        calendar: CalendarPort<string>,
        reschedule: ReschedulePort<string>,
        store: TypeormRescheduleStore<string>,
      ) =>
        new RescheduleConfirmationService<string>(calendar, reschedule, store),
      inject: [ZaloCalendarPort, ZaloReschedulePort, TypeormRescheduleStore],
    },
    ZaloOutboundService,
    CleanupCronService,
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
            sendText: (externalUserId, text) =>
              outboundService.sendText(externalUserId, text, {
                skipDeadLetter: true,
              }),
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
        oauthStateRepo: Repository<ZaloOauthStateEntity>,
        messageLogRepo: Repository<ZaloMessageLogEntity>,
        deadLetterRepo: Repository<WebhookDeadLetterEntity>,
        idempotencyRepo: Repository<ChatIdempotencyEntity>,
        reportClaimRepo: Repository<ScheduledReportClaimEntity>,
        rateLimitService: PlatformChatRateLimitService,
      ) =>
        new PlatformCleanupCronService(cleanupService, configService, {
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
        }),
      inject: [
        CleanupCronService,
        ConfigService,
        getRepositoryToken(ZaloOauthStateEntity),
        getRepositoryToken(ZaloMessageLogEntity),
        getRepositoryToken(WebhookDeadLetterEntity),
        getRepositoryToken(ChatIdempotencyEntity),
        getRepositoryToken(ScheduledReportClaimEntity),
        PlatformChatRateLimitService,
      ],
    },
    ZaloChatService,
  ],
  exports: [
    'LLM_PROVIDER_ADAPTER',
    ZaloChatService,
    ZaloOutboundService,
    PlatformDeadLetterService,
  ],
})
export class ZaloChatModule {}
