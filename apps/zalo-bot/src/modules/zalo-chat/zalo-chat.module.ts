import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  createFailoverLlmProviderAdapter,
  type LlmProviderAdapter,
  type LlmProviderEntryConfig,
} from '@wispace/llm-agent';
import {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmUsageEventEntity,
  LlmSafetyEventEntity,
} from '@wispace/chat-metering';
import { ZaloOauthModule } from '../zalo-oauth/zalo-oauth.module';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { ZaloAgentService } from './application/agent/zalo-agent.service';
import { ZaloAgentToolsService } from './application/agent/zalo-agent-tools.service';
import { ZaloChatHistoryService } from './application/services/zalo-chat-history.service';
import { ZaloOutboundService } from './application/services/zalo-outbound.service';
import { ZaloChatService } from './application/services/zalo-chat.service';
import { ZaloChatRateLimitService } from './application/services/zalo-chat-rate-limit.service';
import { ZaloLlmUsageConfigService } from './application/services/zalo-llm-usage-config.service';
import { ZaloLlmUsageRecorderService } from './application/services/zalo-llm-usage-recorder.service';
import { ZaloLlmSafetyEventService } from './application/services/zalo-llm-safety-event.service';
import { ZaloRescheduleConfirmationService } from './application/services/zalo-reschedule-confirmation.service';
import { ZaloStudyCalendarCommandService } from './application/services/zalo-study-calendar-command.service';
import { ZaloCalendarPort } from './infrastructure/adapters/zalo-calendar.port';
import { ZaloReschedulePort } from './infrastructure/adapters/zalo-reschedule.port';
import { ZaloDeadLetterService } from './application/services/zalo-dead-letter.service';
import { ZaloDeadLetterCronService } from './application/services/zalo-dead-letter-cron.service';
import { ZaloChatQueueService } from './application/services/zalo-chat-queue.service';
import { ZaloDeliveryLogService } from './application/services/zalo-delivery-log.service';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { ZaloCleanupCronService } from './application/services/zalo-cleanup-cron.service';
import { ZaloMessageLogEntity } from '../../infrastructure/database/entities/zalo-message-log.entity';
import { WebhookDeadLetterEntity } from '@wispace/database';
import { ZaloOauthStateEntity } from '../../infrastructure/database/entities/zalo-oauth-state.entity';

@Module({
  imports: [
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

        if (order.length === 0) {
          return createFailoverLlmProviderAdapter(
            [
              {
                provider: 'openai',
                getApiKey: () =>
                  configService.get<string>('OPENAI_API_KEY')?.trim() ||
                  undefined,
                getModel: () =>
                  configService.get<string>('OPENAI_MODEL')?.trim() ||
                  'gpt-5.4',
              },
            ],
            ['openai'],
            { warn: (m) => console.warn(m) },
          );
        }

        const entries: LlmProviderEntryConfig[] = [
          {
            provider: 'openai',
            getApiKey: () =>
              configService.get<string>('OPENAI_API_KEY')?.trim() || undefined,
            getModel: () =>
              configService.get<string>('OPENAI_MODEL')?.trim() || 'gpt-5.4',
          },
        ];

        return createFailoverLlmProviderAdapter(
          entries,
          order,
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
    ZaloLlmUsageConfigService,
    ZaloLlmUsageRecorderService,
    ZaloLlmSafetyEventService,
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
    ZaloDeadLetterService,
    ZaloDeadLetterCronService,
    ZaloDeliveryLogService,
    CleanupCronService,
    ZaloCleanupCronService,
    ZaloChatService,
  ],
  exports: [
    'LLM_PROVIDER_ADAPTER',
    ZaloChatService,
    ZaloOutboundService,
    ZaloChatRateLimitService,
    ZaloLlmUsageRecorderService,
    ZaloCleanupCronService,
    CleanupCronService,
    ZaloDeadLetterService,
  ],
})
export class ZaloChatModule {}
