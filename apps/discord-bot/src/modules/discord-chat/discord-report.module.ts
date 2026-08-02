import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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
    DiscordSharedModule,
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
      provide: DISCORD_REPORT_PORT,
      useExisting: DiscordStudentReportService,
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
    DiscordStudentReportService,
  ],
  exports: [DiscordReportCronService, DiscordReportRetryDispatchService],
})
export class DiscordReportModule {}
