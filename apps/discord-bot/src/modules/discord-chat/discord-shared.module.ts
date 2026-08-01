import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createLlmProviderAdapter,
  createFailoverLlmProviderAdapter,
  type LlmProviderAdapter,
  type LlmProviderEntryConfig,
} from '@wispace/llm-agent';
import { REPORT_DELIVERY_PORT } from '@wispace/scheduler-core';
import { DiscordReportDeliveryService } from './application/services/discord-report-delivery.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordMessageLogEntity } from '../../infrastructure/database/entities/discord-message-log.entity';
import { DiscordAccountLinkEntity } from '../../infrastructure/database/entities/discord-account-link.entity';
import { DiscordDeliveryLogService } from './application/services/discord-delivery-log.service';
import { DiscordOutboundService } from './application/services/discord-outbound.service';

/**
 * Shared providers for Discord modules — breaks circular dependency between
 * DiscordChatModule ↔ DiscordReportModule.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DiscordMessageLogEntity,
      DiscordAccountLinkEntity,
    ]),
  ],
  providers: [
    DiscordDeliveryLogService,
    DiscordOutboundService,
    {
      provide: 'LLM_PROVIDER_ADAPTER',
      useFactory: (configService: ConfigService): LlmProviderAdapter => {
        const orderRaw = configService
          .get<string>('LLM_PROVIDER_FAILOVER_ORDER')
          ?.trim();
        const order = orderRaw
          ? orderRaw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [];

        if (order.length === 0) {
          return createLlmProviderAdapter({
            getApiKey: () =>
              configService.get<string>('OPENAI_API_KEY')?.trim() || undefined,
            getModel: () =>
              configService.get<string>('OPENAI_MODEL')?.trim() || 'gpt-5.4',
          });
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
        ];

        return createFailoverLlmProviderAdapter(entries, order, {
          warn: (m) => console.warn(m),
        });
      },
      inject: [ConfigService],
    },
    DiscordReportDeliveryService,
    {
      provide: REPORT_DELIVERY_PORT,
      useExisting: DiscordReportDeliveryService,
    },
  ],
  exports: [
    'LLM_PROVIDER_ADAPTER',
    REPORT_DELIVERY_PORT,
    DiscordOutboundService,
  ],
})
export class DiscordSharedModule {}
