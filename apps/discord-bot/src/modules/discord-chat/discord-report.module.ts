import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'path';
import { PlatformStudentReportService } from '@wispace/student-report';
import {
  ReportScheduleService,
  ReportSendScheduleService,
  ReportCronLeaderService,
  ReportCronLockService,
  REPORT_SEND_JOB_REPOSITORY,
  REPORT_CLAIM_REPOSITORY,
  GOALS_DATA_PORT,
} from '@wispace/scheduler-core';
import {
  ReportSendJobEntity,
  ScheduledReportClaimEntity,
} from '@wispace/database';
import { PlatformLlmUsageRecorderAdapter } from '@wispace/chat-metering';
import { WispaceGoalsService } from '@wispace/wispace-client';
import type { LlmProviderAdapter } from '@wispace/llm-agent';
import { DiscordAccountLinkEntity } from '../../infrastructure/database/entities/discord-account-link.entity';
import { DiscordReportDeliveryService } from './application/services/discord-report-delivery.service';
import { DiscordReportSendJobRepository } from './infrastructure/persistence/discord-report-send-job.repository';
import { DiscordReportClaimRepository } from './infrastructure/persistence/discord-report-claim.repository';
import { DiscordReportCronService } from './application/services/discord-report-cron.service';
import { DiscordReportRetryDispatchService } from './application/services/discord-report-retry-dispatch.service';
import { DiscordReportOrchestrationService } from './application/services/discord-report-orchestration.service';
import { DiscordGoalsDataAdapter } from './infrastructure/adapters/discord-goals-data.adapter';
import { DiscordOutboundModule } from './discord-outbound.module';
import { DiscordSharedModule } from './discord-shared.module';
import { BotCommonModule } from '@wispace/bot-common';
import { AccountLinkModule } from '../account-link/account-link.module';
import { WispaceModule } from '../wispace/wispace.module';
import { ChatMeteringModule } from '../chat-metering/chat-metering.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ReportSendJobEntity,
      ScheduledReportClaimEntity,
      DiscordAccountLinkEntity,
    ]),
    DiscordOutboundModule,
    DiscordSharedModule,
    BotCommonModule,
    AccountLinkModule,
    WispaceModule,
    ChatMeteringModule,
  ],
  providers: [
    {
      provide: GOALS_DATA_PORT,
      useExisting: DiscordGoalsDataAdapter,
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
      provide: PlatformStudentReportService,
      useFactory: (
        configService: ConfigService,
        goalsService: WispaceGoalsService,
        usageRecorder: PlatformLlmUsageRecorderAdapter,
        adapter: LlmProviderAdapter,
      ) =>
        new PlatformStudentReportService(
          'discord',
          configService,
          goalsService,
          usageRecorder,
          adapter,
          join(__dirname, '../../shared/prompts'),
        ),
      inject: [
        ConfigService,
        WispaceGoalsService,
        PlatformLlmUsageRecorderAdapter,
        'LLM_PROVIDER_ADAPTER',
      ],
    },
    ReportScheduleService,
    ReportSendScheduleService,
    ReportCronLeaderService,
    ReportCronLockService,
    DiscordGoalsDataAdapter,
    DiscordReportDeliveryService,
    DiscordReportSendJobRepository,
    DiscordReportClaimRepository,
    DiscordReportCronService,
    DiscordReportRetryDispatchService,
    DiscordReportOrchestrationService,
  ],
  exports: [DiscordReportCronService, DiscordReportRetryDispatchService],
})
export class DiscordReportModule {}
