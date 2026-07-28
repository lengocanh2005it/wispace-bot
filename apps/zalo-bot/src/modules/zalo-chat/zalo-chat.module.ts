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

@Module({
  imports: [
    ZaloOauthModule,
    ZaloWispaceModule,
    TypeOrmModule.forFeature([
      ChatDailyUsageEntity,
      ChatIdempotencyEntity,
      LlmUsageEventEntity,
      LlmSafetyEventEntity,
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
          {
            provider: 'openrouter',
            getApiKey: () =>
              configService.get<string>('OPENROUTER_API_KEY')?.trim() ||
              undefined,
            getModel: () =>
              configService.get<string>('OPENROUTER_MODEL')?.trim() ||
              'openai/gpt-4o-mini',
            getBaseUrl: () =>
              configService.get<string>('OPENROUTER_BASE_URL')?.trim() ||
              'https://openrouter.ai/api/v1',
          },
          {
            provider: 'minimax',
            getApiKey: () =>
              configService.get<string>('MINIMAX_API_KEY')?.trim() || undefined,
            getModel: () =>
              configService.get<string>('MINIMAX_MODEL')?.trim() ||
              'MiniMax-Text-01',
            getBaseUrl: () =>
              configService.get<string>('MINIMAX_BASE_URL')?.trim() ||
              'https://api.minimax.chat/v1',
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
    ZaloChatService,
  ],
  exports: [ZaloChatService, ZaloOutboundService],
})
export class ZaloChatModule {}
