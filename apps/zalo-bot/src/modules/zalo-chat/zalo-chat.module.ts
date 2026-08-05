import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
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
  PlatformLlmUsageRecorderAdapter,
  PlatformLlmSafetyEventAdapter,
} from '@wispace/chat-metering';
import { ZaloOauthModule } from '../zalo-oauth/zalo-oauth.module';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { BotCommonModule } from '@wispace/bot-common';
import { ZaloAgentService } from './application/agent/zalo-agent.service';
import { ZaloAgentToolsService } from './application/agent/zalo-agent-tools.service';
import { ZaloChatHistoryService } from './application/services/zalo-chat-history.service';
import { ZaloOutboundService } from './application/services/zalo-outbound.service';
import { ZaloChatService } from './application/services/zalo-chat.service';
import { ZaloChatRateLimitService } from './infrastructure/persistence/zalo-chat-rate-limit.service';
import { ZaloRescheduleConfirmationService } from './application/services/zalo-reschedule-confirmation.service';
import { ZaloStudyCalendarCommandService } from './application/services/zalo-study-calendar-command.service';
import { ZaloCalendarPort } from './infrastructure/adapters/zalo-calendar.port';
import { ZaloReschedulePort } from './infrastructure/adapters/zalo-reschedule.port';
import { ZaloDeadLetterCronService } from './application/services/zalo-dead-letter-cron.service';
import { ZaloChatQueueService } from './application/services/zalo-chat-queue.service';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { ZaloCleanupCronService } from './infrastructure/persistence/zalo-cleanup-cron.service';
import { ZaloMessageLogEntity } from '../../infrastructure/database/entities/zalo-message-log.entity';
import {
  DeliveryLogService,
  PlatformDeadLetterService,
  WebhookDeadLetterEntity,
} from '@wispace/database';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

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
    ZaloStudyCalendarCommandService,
    ZaloCalendarPort,
    ZaloReschedulePort,
    ZaloRescheduleConfirmationService,
    ZaloAgentService,
    ZaloAgentToolsService,
    ZaloChatHistoryService,
    ZaloOutboundService,
    ZaloChatRateLimitService,
    ZaloChatQueueService,
    ZaloDeadLetterCronService,
    CleanupCronService,
    ZaloCleanupCronService,
    ZaloChatService,
  ],
  exports: [
    'LLM_PROVIDER_ADAPTER',
    ZaloChatService,
    ZaloOutboundService,
    ZaloChatRateLimitService,
    PlatformLlmUsageRecorderAdapter,
    ZaloCleanupCronService,
    CleanupCronService,
    PlatformDeadLetterService,
  ],
})
export class ZaloChatModule {}
