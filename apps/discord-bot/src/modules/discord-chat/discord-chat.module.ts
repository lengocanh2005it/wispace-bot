import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { join } from 'path';
import {
  CleanupCronService,
  PlatformCleanupCronService,
} from '@wispace/cleanup-cron';
import {
  BotCommonModule,
  PgAdvisoryLockService,
  REDIS_CLIENT,
} from '@wispace/bot-common';
import {
  ChatMeteringModule,
  PlatformChatRateLimitService,
  PlatformLlmSafetyEventAdapter,
  PlatformLlmUsageRecorderAdapter,
  ChatIdempotencyEntity,
} from '@wispace/chat-metering';
import { AccountLinkModule } from '../account-link/account-link.module';
import { WispaceModule } from '../wispace/wispace.module';
import {
  PlatformAgentService,
  PlatformAgentToolsService,
  PlatformChatHistoryService,
  PlatformChatQueueService,
  createChatPipelineAdapters,
} from '@wispace/chat-agent';
import type { LlmProviderAdapter } from '@wispace/llm-agent';
import {
  WispaceCalendarService,
  WispaceGoalsService,
} from '@wispace/wispace-client';
import { REPORT_DELIVERY_PORT } from '@wispace/scheduler-core';
import type { ReportDeliveryPort } from '@wispace/scheduler-core';
import {
  RescheduleConfirmationService,
  type CalendarPort,
  type ReschedulePort,
} from '@wispace/reschedule-confirm';
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
} from '@wispace/database';
import { DiscordMessageLogEntity } from '../../infrastructure/database/entities/discord-message-log.entity';
import { DiscordCalendarPort } from './infrastructure/adapters/discord-calendar.port';
import { DiscordReschedulePort } from './infrastructure/adapters/discord-reschedule.port';
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
        rescheduleConfirmationService: RescheduleConfirmationService<string>,
        outboundService: DiscordOutboundService,
        reportDeliveryPort?: ReportDeliveryPort,
      ) =>
        new PlatformAgentToolsService(
          goalsService,
          calendarService,
          rescheduleConfirmationService,
          {
            getNotLinkedMessage: () => NOT_LINKED_MESSAGE,
            wispaceExternalId: (ctx) => ctx.externalUserId,
            registerReportMessage: REGISTER_REPORT_MESSAGE,
            reportDeliveryPort,
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
        ),
      inject: [
        WispaceGoalsService,
        WispaceCalendarService,
        RescheduleConfirmationService,
        DiscordOutboundService,
        { token: REPORT_DELIVERY_PORT, optional: true },
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
            promptFile: 'discord-chat.system.txt',
            // Single retry layer — retryWithBackoff in PlatformAgentService
            maxLlmRetries: 0,
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
        outboundService: DiscordOutboundService,
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
          },
        );
      },
      inject: [
        ConfigService,
        PlatformChatRateLimitService,
        PlatformChatHistoryService,
        PlatformAgentService,
        DiscordOutboundService,
      ],
    },
    DiscordCalendarPort,
    DiscordReschedulePort,
    {
      provide: RescheduleConfirmationService,
      useFactory: (
        calendar: CalendarPort<string>,
        reschedule: ReschedulePort<string>,
      ) => new RescheduleConfirmationService<string>(calendar, reschedule),
      inject: [DiscordCalendarPort, DiscordReschedulePort],
    },
    DiscordMenuService,
    CleanupCronService,
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
            lockId: 884_200_930,
            extractPayload: (payload) => ({
              externalUserId: payload.discordUserId as string | undefined,
              text: payload.text as string | undefined,
            }),
            abandonReason: 'Missing discordUserId or text in payload',
            sendText: (externalUserId, text) =>
              outboundService.sendText(externalUserId, text, {
                skipDeadLetter: true,
              }),
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
        messageLogRepo: Repository<DiscordMessageLogEntity>,
        deadLetterRepo: Repository<WebhookDeadLetterEntity>,
        idempotencyRepo: Repository<ChatIdempotencyEntity>,
        reportClaimRepo: Repository<ScheduledReportClaimEntity>,
        rateLimitService: PlatformChatRateLimitService,
      ) =>
        new PlatformCleanupCronService(cleanupService, configService, {
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
        }),
      inject: [
        CleanupCronService,
        ConfigService,
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
