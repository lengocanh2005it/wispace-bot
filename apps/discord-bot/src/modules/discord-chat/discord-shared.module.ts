import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createFailoverLlmProviderAdapter,
  createFailoverProviderEntries,
  type LlmProviderAdapter,
} from '@wispace/llm-agent';
import { REPORT_DELIVERY_PORT } from '@wispace/scheduler-core';
import { DiscordReportDeliveryService } from './application/services/discord-report-delivery.service';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DeliveryLogService } from '@wispace/database';
import { Repository } from 'typeorm';
import { DiscordMessageLogEntity } from '../../infrastructure/database/entities/discord-message-log.entity';
import { DiscordAccountLinkEntity } from '../../infrastructure/database/entities/discord-account-link.entity';
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
    {
      provide: DeliveryLogService,
      useFactory: (repo: Repository<DiscordMessageLogEntity>) =>
        new DeliveryLogService(repo),
      inject: [getRepositoryToken(DiscordMessageLogEntity)],
    },
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

        const providerOrder = order.length > 0 ? order : ['openai'];
        const entries = createFailoverProviderEntries(
          (key) => configService.get<string>(key)?.trim(),
          providerOrder,
        );

        return createFailoverLlmProviderAdapter(entries, providerOrder, {
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
