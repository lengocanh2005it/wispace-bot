import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
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
import { DiscordGoalsDataAdapter } from './infrastructure/adapters/discord-goals-data.adapter';
import { DiscordOutboundModule } from './discord-outbound.module';
import { AccountLinkModule } from '../account-link/account-link.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ReportSendJobEntity,
      ScheduledReportClaimEntity,
      DiscordAccountLinkEntity,
    ]),
    DiscordOutboundModule,
    AccountLinkModule,
  ],
  providers: [
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
    ReportScheduleService,
    ReportSendScheduleService,
    ReportCronLeaderService,
    ReportCronLockService,
    DiscordReportDeliveryService,
    DiscordReportSendJobRepository,
    DiscordReportClaimRepository,
    DiscordReportCronService,
    DiscordReportRetryDispatchService,
  ],
  exports: [DiscordReportCronService, DiscordReportRetryDispatchService],
})
export class DiscordReportModule {}
