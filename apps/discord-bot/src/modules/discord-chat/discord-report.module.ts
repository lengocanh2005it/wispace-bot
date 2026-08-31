import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { join } from 'path';
import { PlatformStudentReportService } from '@wispace/student-report';
import { PlatformLlmUsageRecorderAdapter } from '@wispace/chat-metering';
import { BotMetricsService } from '@wispace/bot-metrics';
import type { LlmProviderAdapter } from '@wispace/llm-agent';
import {
  ReportScheduleService,
  ReportSendScheduleService,
  ReportCronLeaderService,
  ReportCronLockService,
  CronLeaderHeartbeatService,
  ReportOrchestrationService,
  REPORT_SEND_JOB_REPOSITORY,
  REPORT_CLAIM_REPOSITORY,
  GOALS_DATA_PORT,
  parseExamDateToIso,
  type ReportClaimRepositoryPort,
} from '@wispace/scheduler-core';
import {
  ReportSendJobEntity,
  ScheduledReportClaimEntity,
  PlatformReportClaimRepository,
  CronLeaderLeaseEntity,
  CronLeaderLeaseService,
  ReportClaimStaleResetCronService,
} from '@wispace/database';
import { ChatMeteringModule } from '@wispace/chat-metering';
import {
  MemoizedWispaceGoalsService,
  WispaceDataCache,
  WispaceGoalsService,
} from '@wispace/wispace-client';
import { DiscordAccountLinkEntity } from '../../infrastructure/database/entities/discord-account-link.entity';
import { DiscordReportDeliveryService } from './application/services/discord-report-delivery.service';
import { DiscordReportSendJobRepository } from './infrastructure/persistence/discord-report-send-job.repository';
import { TypeormDiscordReportAccountReader } from './infrastructure/persistence/typeorm-discord-report-account.reader';
import { DISCORD_REPORT_ACCOUNT_READER } from './domain/ports/discord-report-account-reader.port';
import { DiscordReportCronService } from './application/services/discord-report-cron.service';
import { DiscordReportRetryDispatchService } from './application/services/discord-report-retry-dispatch.service';
import { DiscordReportOrchestrationService } from './application/services/discord-report-orchestration.service';
import { DiscordOutboundModule } from './discord-outbound.module';
import { DiscordSharedModule } from './discord-shared.module';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import { WispaceModule } from '../wispace/wispace.module';
import { DatabaseModule } from '../../infrastructure/database/database.module';

const DISCORD_REPORT_CLAIM_STALE_RESET_LOCK = 884_200_935;

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ReportSendJobEntity,
      ScheduledReportClaimEntity,
      DiscordAccountLinkEntity,
      CronLeaderLeaseEntity,
    ]),
    DiscordOutboundModule,
    DiscordSharedModule,
    BotCommonModule,
    WispaceModule,
    DatabaseModule,
    ChatMeteringModule.forPlatform('discord', {
      requireEnv: true,
      lenientEnabledCheck: true,
    }),
  ],
  providers: [
    // Request-scoped goals memoization: exam window, orchestration and report
    // generation all fetch goals within one report execution — collapse them
    // into a single upstream call (TTL from the central #636 policy).
    {
      provide: MemoizedWispaceGoalsService,
      useFactory: (
        goalsService: WispaceGoalsService,
        cache: WispaceDataCache,
      ) => new MemoizedWispaceGoalsService(goalsService, cache),
      inject: [WispaceGoalsService, WispaceDataCache],
    },
    {
      provide: GOALS_DATA_PORT,
      useFactory: (goalsService: MemoizedWispaceGoalsService) => ({
        getUserGoals: async (externalUserId: string) => ({
          examDate: (await goalsService.getUserGoals(externalUserId)).examDate,
        }),
        parseExamDate: (examDate: string) => parseExamDateToIso(examDate),
      }),
      inject: [MemoizedWispaceGoalsService],
    },
    {
      provide: REPORT_SEND_JOB_REPOSITORY,
      useExisting: DiscordReportSendJobRepository,
    },
    {
      provide: REPORT_CLAIM_REPOSITORY,
      useFactory: (repo: Repository<ScheduledReportClaimEntity>) =>
        new PlatformReportClaimRepository('discord', repo),
      inject: [getRepositoryToken(ScheduledReportClaimEntity)],
    },
    {
      provide: ReportClaimStaleResetCronService,
      useFactory: (
        configService: ConfigService,
        claimRepository: ReportClaimRepositoryPort,
        pgLock: PgAdvisoryLockService,
      ) =>
        new ReportClaimStaleResetCronService(
          configService,
          claimRepository,
          pgLock,
          {
            platform: 'discord',
            lockId: DISCORD_REPORT_CLAIM_STALE_RESET_LOCK,
          },
        ),
      inject: [ConfigService, REPORT_CLAIM_REPOSITORY, PgAdvisoryLockService],
    },
    {
      provide: PlatformStudentReportService,
      useFactory: (
        configService: ConfigService,
        goalsService: MemoizedWispaceGoalsService,
        usageRecorder: PlatformLlmUsageRecorderAdapter,
        adapter: LlmProviderAdapter,
        metrics: BotMetricsService,
      ) =>
        new PlatformStudentReportService(
          'discord',
          configService,
          goalsService,
          usageRecorder,
          adapter,
          join(__dirname, '../../shared/prompts'),
          undefined,
          metrics.llmAdmission,
          (event) => metrics.incLlmDegradedMode(event),
        ),
      inject: [
        ConfigService,
        MemoizedWispaceGoalsService,
        PlatformLlmUsageRecorderAdapter,
        'LLM_PROVIDER_ADAPTER',
        BotMetricsService,
      ],
    },
    ReportScheduleService,
    ReportSendScheduleService,
    CronLeaderLeaseService,
    {
      provide: ReportCronLeaderService,
      useFactory: (
        configService: ConfigService,
        leaseService: CronLeaderLeaseService,
      ) => new ReportCronLeaderService(configService, leaseService),
      inject: [ConfigService, CronLeaderLeaseService],
    },
    CronLeaderHeartbeatService,
    ReportCronLockService,
    ReportOrchestrationService,
    DiscordReportDeliveryService,
    DiscordReportSendJobRepository,
    TypeormDiscordReportAccountReader,
    {
      provide: DISCORD_REPORT_ACCOUNT_READER,
      useExisting: TypeormDiscordReportAccountReader,
    },
    DiscordReportCronService,
    DiscordReportRetryDispatchService,
    DiscordReportOrchestrationService,
  ],
  exports: [DiscordReportCronService, DiscordReportRetryDispatchService],
})
export class DiscordReportModule {}
