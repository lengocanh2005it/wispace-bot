import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import {
  createFailoverLlmProviderAdapter,
  createFailoverProviderEntries,
  type LlmProviderAdapter,
} from '@wispace/llm-agent';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmUsageEventEntity,
  LlmSafetyEventEntity,
  LlmUsageConfigService,
  PlatformChatRateLimitService,
  PlatformLlmUsageRecorderAdapter,
  PlatformLlmSafetyEventAdapter,
} from '@wispace/chat-metering';
import {
  PlatformAgentService,
  PlatformAgentToolsService,
  PlatformChatHistoryService,
  PlatformChatQueueService,
} from '@wispace/chat-agent';
import {
  WispaceCalendarService,
  WispaceConfigService,
  WispaceGoalsService,
} from '@wispace/wispace-client';
import { BotCommonModule, REDIS_CLIENT } from '@wispace/bot-common';
import type { RedisService } from '@wispace/bot-common';
import { ZaloOauthModule } from '../zalo-oauth/zalo-oauth.module';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { ZaloOutboundService } from './application/services/zalo-outbound.service';
import { ZaloChatService } from './application/services/zalo-chat.service';
import { RescheduleConfirmationService } from '@wispace/reschedule-confirm';
import { PlatformStudyCalendarCommandService } from '@wispace/study-reminder-shared';
import { ZaloCalendarPort } from './infrastructure/adapters/zalo-calendar.port';
import { ZaloReschedulePort } from './infrastructure/adapters/zalo-reschedule.port';
import {
  PlatformDeadLetterCronService,
  PlatformDeadLetterService,
} from '@wispace/database';
import {
  CleanupCronService,
  PlatformCleanupCronService,
} from '@wispace/cleanup-cron';
import { ZaloMessageLogEntity } from '../../infrastructure/database/entities/zalo-message-log.entity';
import { DeliveryLogService, WebhookDeadLetterEntity } from '@wispace/database';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ZaloAgentAdapter,
  ZaloHistoryAdapter,
  ZaloOutboundAdapter,
  ZaloRateLimiterAdapter,
} from './infrastructure/adapters/zalo-chat-pipeline.adapters';

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
    TypeOrmModule.forFeature([
      ChatDailyUsageEntity,
      ChatIdempotencyEntity,
      LlmUsageEventEntity,
      LlmSafetyEventEntity,
      ZaloMessageLogEntity,
      WebhookDeadLetterEntity,
      ZaloOauthStateEntity,
    ]),
  ],
  providers: [
    {
      provide: 'LLM_PROVIDER_ADAPTER',
      useFactory: (configService: ConfigService): LlmProviderAdapter => {
        const order =
          configService
            .get<string>('LLM_PROVIDER_FAILOVER_ORDER')
            ?.trim()
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean) ?? [];

        const entries = createFailoverProviderEntries(
          (key) => configService.get<string>(key)?.trim(),
          order.length > 0 ? order : ['openai'],
        );

        return createFailoverLlmProviderAdapter(
          entries,
          order.length > 0 ? order : ['openai'],
          { warn: (m) => console.warn(m) },
          {
            cooldownLongMs: Number(
              configService
                .get<string>('LLM_FAILOVER_COOLDOWN_LONG_MS')
                ?.trim() ?? 600_000,
            ),
            cooldownShortMs: Number(
              configService
                .get<string>('LLM_FAILOVER_COOLDOWN_SHORT_MS')
                ?.trim() ?? 5_000,
            ),
            quickRetryDelayMs: Number(
              configService
                .get<string>('LLM_FAILOVER_QUICK_RETRY_DELAY_MS')
                ?.trim() ?? 150,
            ),
          },
        );
      },
      inject: [ConfigService],
    },
    LlmUsageConfigService,
    {
      provide: PlatformChatRateLimitService,
      useFactory: (
        configService: ConfigService,
        dailyUsageRepo: Repository<ChatDailyUsageEntity>,
        idempotencyRepo: Repository<ChatIdempotencyEntity>,
      ) =>
        new PlatformChatRateLimitService(
          { platform: 'zalo' },
          configService,
          dailyUsageRepo,
          idempotencyRepo,
        ),
      inject: [
        ConfigService,
        getRepositoryToken(ChatDailyUsageEntity),
        getRepositoryToken(ChatIdempotencyEntity),
      ],
    },
    {
      provide: PlatformLlmUsageRecorderAdapter,
      useFactory: (
        configService: LlmUsageConfigService,
        usageRepo: Repository<LlmUsageEventEntity>,
      ) =>
        new PlatformLlmUsageRecorderAdapter('zalo', configService, usageRepo),
      inject: [LlmUsageConfigService, getRepositoryToken(LlmUsageEventEntity)],
    },
    {
      provide: PlatformLlmSafetyEventAdapter,
      useFactory: (
        safetyRepo: Repository<LlmSafetyEventEntity>,
        configService: ConfigService,
      ) => new PlatformLlmSafetyEventAdapter('zalo', safetyRepo, configService),
      inject: [getRepositoryToken(LlmSafetyEventEntity), ConfigService],
    },
    {
      provide: DeliveryLogService,
      useFactory: (repo: Repository<ZaloMessageLogEntity>) =>
        new DeliveryLogService(repo),
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
        redisClient?: RedisService | null,
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
            wispaceExternalId: (ctx) => String(ctx.userId),
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
        );
      },
      inject: [
        ConfigService,
        WispaceGoalsService,
        WispaceCalendarService,
        RescheduleConfirmationService,
        ZaloOutboundService,
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
      ) =>
        new PlatformAgentService(
          configService,
          toolsService,
          historyService,
          usageRecorder,
          safetyEventService,
          adapter,
          {
            promptDir: join(__dirname, '../../shared/prompts'),
            promptFile: 'zalo-chat.system.txt',
          },
        ),
      inject: [
        ConfigService,
        PlatformAgentToolsService,
        PlatformChatHistoryService,
        PlatformLlmUsageRecorderAdapter,
        PlatformLlmSafetyEventAdapter,
        'LLM_PROVIDER_ADAPTER',
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
      ) =>
        new PlatformChatQueueService(
          configService,
          new ZaloRateLimiterAdapter(rateLimitService),
          new ZaloHistoryAdapter(historyService),
          new ZaloAgentAdapter(agentService),
          new ZaloOutboundAdapter(outboundService),
          outboundService,
        ),
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
      provide: RescheduleConfirmationService,
      useFactory: (
        calendarPort: ZaloCalendarPort,
        reschedulePort: ZaloReschedulePort,
      ) =>
        new RescheduleConfirmationService<string>(calendarPort, reschedulePort),
      inject: [ZaloCalendarPort, ZaloReschedulePort],
    },
    ZaloOutboundService,
    CleanupCronService,
    {
      provide: PlatformDeadLetterCronService,
      useFactory: (
        deadLetterService: PlatformDeadLetterService,
        configService: ConfigService,
        outboundService: ZaloOutboundService,
      ) =>
        new PlatformDeadLetterCronService(deadLetterService, configService, {
          extractPayload: (payload) => ({
            externalUserId:
              (payload.zaloUserId as string | undefined) ??
              (payload.sender as { id?: string } | undefined)?.id,
            text:
              (payload.text as string | undefined) ??
              (payload.message as { text?: string } | undefined)?.text,
          }),
          abandonReason: 'Missing zaloUserId or text in payload',
          sendText: (externalUserId, text) =>
            outboundService.sendText(externalUserId, text),
        }),
      inject: [PlatformDeadLetterService, ConfigService, ZaloOutboundService],
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
          },
          messageLogRepo,
          deadLetterRepo,
          idempotencyRepo,
          oauthStateRepo,
          rateLimitService,
        }),
      inject: [
        CleanupCronService,
        ConfigService,
        getRepositoryToken(ZaloOauthStateEntity),
        getRepositoryToken(ZaloMessageLogEntity),
        getRepositoryToken(WebhookDeadLetterEntity),
        getRepositoryToken(ChatIdempotencyEntity),
        PlatformChatRateLimitService,
      ],
    },
    ZaloChatService,
  ],
  exports: [
    'LLM_PROVIDER_ADAPTER',
    ZaloChatService,
    ZaloOutboundService,
    PlatformChatRateLimitService,
    PlatformLlmUsageRecorderAdapter,
    PlatformCleanupCronService,
    CleanupCronService,
    PlatformDeadLetterService,
  ],
})
export class ZaloChatModule {}
