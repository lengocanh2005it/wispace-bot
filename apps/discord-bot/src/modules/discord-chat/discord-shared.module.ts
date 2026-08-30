import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createLlmProviderAdapterFromEnv,
  type LlmProviderAdapter,
} from '@wispace/llm-agent';
import { REPORT_DELIVERY_PORT } from '@wispace/scheduler-core';
import { DiscordReportDeliveryService } from './application/services/discord-report-delivery.service';
import { TypeormDiscordReportAccountReader } from './infrastructure/persistence/typeorm-discord-report-account.reader';
import { DISCORD_REPORT_ACCOUNT_READER } from './domain/ports/discord-report-account-reader.port';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscordMessageLogEntity } from '../../infrastructure/database/entities/discord-message-log.entity';
import { DiscordAccountLinkEntity } from '../../infrastructure/database/entities/discord-account-link.entity';
import { DiscordOutboundModule } from './discord-outbound.module';
import { BotMetricsService } from '@wispace/bot-metrics';

/**
 * Shared providers for Discord modules — breaks circular dependency between
 * DiscordChatModule ⇄ DiscordReportModule.
 */
@Module({
  imports: [
    DiscordOutboundModule,
    TypeOrmModule.forFeature([
      DiscordMessageLogEntity,
      DiscordAccountLinkEntity,
    ]),
  ],
  providers: [
    {
      provide: 'LLM_PROVIDER_ADAPTER',
      useFactory: (
        configService: ConfigService,
        metrics: BotMetricsService,
      ): LlmProviderAdapter =>
        createLlmProviderAdapterFromEnv(
          (key) => configService.get<string>(key)?.trim(),
          {
            onCircuitEvent: (event) =>
              metrics.incLlmProviderCircuitEvent(
                event.provider,
                event.action,
                event.reason,
              ),
            onProviderAttempt: (provider, feature) =>
              metrics.incLlmProviderAttempt(provider, feature),
            onProvidersExhausted: (providers, feature) =>
              metrics.incLlmProvidersExhausted(providers.length, feature),
          },
        ),
      inject: [ConfigService, BotMetricsService],
    },
    DiscordReportDeliveryService,
    TypeormDiscordReportAccountReader,
    {
      provide: DISCORD_REPORT_ACCOUNT_READER,
      useExisting: TypeormDiscordReportAccountReader,
    },
    {
      provide: REPORT_DELIVERY_PORT,
      useExisting: DiscordReportDeliveryService,
    },
  ],
  exports: ['LLM_PROVIDER_ADAPTER', REPORT_DELIVERY_PORT],
})
export class DiscordSharedModule {}
