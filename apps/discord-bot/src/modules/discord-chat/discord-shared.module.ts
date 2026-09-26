import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createLlmProviderAdapterFromEnv,
  createEnvLlmExecutionPort,
  createLlmAdmissionCoordinator,
} from '@wispace/llm-agent/adapters';
import {
  buildLlmExecutionConfig,
  LlmAdmissionCoordinator,
} from '@wispace/llm-agent/core';
import type {
  LlmProviderAdapter,
  LlmExecutionPort,
} from '@wispace/llm-agent/core';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import { REPORT_DELIVERY_PORT } from '@wispace/scheduler-core/core';
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
            onProviderOutcome: (provider, outcome) =>
              metrics.incLlmProviderOutcome(provider, outcome),
            onProviderNeverSucceeded: (provider) =>
              metrics.incLlmProviderNeverSucceeded(provider),
            onProvidersExhausted: (providers, feature) =>
              metrics.incLlmProvidersExhausted(providers.length, feature),
          },
        ),
      inject: [ConfigService, BotMetricsService],
    },
    {
      provide: 'LLM_ADMISSION_COORDINATOR',
      useFactory: (
        configService: ConfigService,
        metrics: BotMetricsService,
        redisClient?: RedisClientPort | null,
      ): LlmAdmissionCoordinator => {
        const config = buildLlmExecutionConfig((key) =>
          configService.get<string>(key)?.trim(),
        );
        return createLlmAdmissionCoordinator(
          config,
          { warn: (message) => console.warn(message) },
          metrics.llmAdmission,
          config.globalConcurrencyEnabled ? (redisClient ?? null) : null,
        );
      },
      inject: [
        ConfigService,
        BotMetricsService,
        { token: REDIS_CLIENT, optional: true },
      ],
    },
    {
      provide: 'LLM_EXECUTION_PORT',
      useFactory: (
        configService: ConfigService,
        adapter: LlmProviderAdapter,
        metrics: BotMetricsService,
        admission: LlmAdmissionCoordinator,
      ): LlmExecutionPort => {
        const config = buildLlmExecutionConfig((key) =>
          configService.get<string>(key)?.trim(),
        );
        return createEnvLlmExecutionPort(
          {
            ...config,
            redis: null,
          },
          adapter,
          { warn: (message) => console.warn(message) },
          metrics.llmAdmission,
          admission,
        );
      },
      inject: [
        ConfigService,
        'LLM_PROVIDER_ADAPTER',
        BotMetricsService,
        'LLM_ADMISSION_COORDINATOR',
      ],
    },
    {
      provide: 'LLM_REPORT_EXECUTION_PORT',
      useFactory: (
        configService: ConfigService,
        adapter: LlmProviderAdapter,
        metrics: BotMetricsService,
        admission: LlmAdmissionCoordinator,
      ): LlmExecutionPort => {
        const config = buildLlmExecutionConfig((key) =>
          configService.get<string>(key)?.trim(),
        );
        return createEnvLlmExecutionPort(
          { ...config, redis: null },
          adapter,
          { warn: (message) => console.warn(message) },
          metrics.llmAdmission,
          admission,
        );
      },
      inject: [
        ConfigService,
        'LLM_PROVIDER_ADAPTER',
        BotMetricsService,
        'LLM_ADMISSION_COORDINATOR',
      ],
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
  exports: [
    'LLM_PROVIDER_ADAPTER',
    'LLM_ADMISSION_COORDINATOR',
    'LLM_EXECUTION_PORT',
    'LLM_REPORT_EXECUTION_PORT',
    REPORT_DELIVERY_PORT,
  ],
})
export class DiscordSharedModule {}
