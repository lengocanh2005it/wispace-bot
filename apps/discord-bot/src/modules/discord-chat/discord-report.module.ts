import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import {
  createLlmProviderAdapter,
  createFailoverLlmProviderAdapter,
  type LlmProviderAdapter,
  type LlmProviderEntryConfig,
} from '@wispace/llm-agent';
import {
  ReportScheduleService,
  ReportSendScheduleService,
  ReportCronLeaderService,
  ReportCronLockService,
  REPORT_DELIVERY_PORT,
  REPORT_SEND_JOB_REPOSITORY,
  REPORT_CLAIM_REPOSITORY,
  GOALS_DATA_PORT,
} from '@wispace/scheduler-core';
import { ReportSendJobEntity } from '../../infrastructure/database/entities/report-send-job.entity';
import { ScheduledReportClaimEntity } from '../../infrastructure/database/entities/scheduled-report-claim.entity';
import { DiscordAccountLinkEntity } from '../../infrastructure/database/entities/discord-account-link.entity';
import { DiscordReportDeliveryService } from './application/services/discord-report-delivery.service';
import { DiscordReportSendJobRepository } from './infrastructure/persistence/discord-report-send-job.repository';
import { DiscordReportClaimRepository } from './infrastructure/persistence/discord-report-claim.repository';
import { DiscordReportCronService } from './application/services/discord-report-cron.service';
import { DiscordReportRetryDispatchService } from './application/services/discord-report-retry-dispatch.service';
import { DiscordReportOrchestrationService } from './application/services/discord-report-orchestration.service';
import { DiscordGoalsDataAdapter } from './infrastructure/adapters/discord-goals-data.adapter';
import { DiscordOutboundModule } from './discord-outbound.module';
import { AccountLinkModule } from '../account-link/account-link.module';
import { AccountLinkModule } from '../account-link/account-link.module';
import { WispaceModule } from '../wispace/wispace.module';
import { ChatMeteringModule } from '../chat-metering/chat-metering.module';
import { DiscordStudentReportService } from './application/services/discord-student-report.service';
import { DISCORD_REPORT_PORT } from './domain/ports/discord-report.port';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ReportSendJobEntity,
      ScheduledReportClaimEntity,
      DiscordAccountLinkEntity,
    ]),
    DiscordOutboundModule,
    AccountLinkModule,
    WispaceModule,
    ChatMeteringModule,
  ],
  providers: [
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
    {
      provide: GOALS_DATA_PORT,
      useFactory: (configService: ConfigService): DiscordGoalsDataAdapter =>
        new DiscordGoalsDataAdapter(configService),
      inject: [ConfigService],
    },
    {
      provide: REPORT_DELIVERY_PORT,
      useExisting: DiscordReportDeliveryService,
    },
    {
      provide: REPORT_SEND_JOB_REPOSITORY,
      useExisting: DiscordReportSendJobRepository,
    },
    {
      provide: REPORT_CLAIM_REPOSITORY,
      useExisting: DiscordReportClaimRepository,
    },
    {
      provide: DISCORD_REPORT_PORT,
      useExisting: DiscordStudentReportService,
    },
    ReportScheduleService,
    ReportSendScheduleService,
    ReportCronLeaderService,
    ReportCronLockService,
    DiscordReportDeliveryService,
    DiscordReportSendJobRepository,
    DiscordReportClaimRepository,
    DiscordReportCronService,
    DiscordReportRetryDispatchService,
    DiscordReportOrchestrationService,
    DiscordStudentReportService,
  ],
  exports: [DiscordReportCronService, DiscordReportRetryDispatchService],
})
export class DiscordReportModule {}
