import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { join } from 'path';
import { PlatformStudentReportService } from '@wispace/student-report/adapters';
import {
  PlatformLlmUsageRecorderAdapter,
  provideWiredUsageRecorder,
  ChatMeteringModule,
} from '@wispace/chat-metering/adapters';
import { BotMetricsService } from '@wispace/bot-metrics';
import type {
  LlmExecutionPort,
  LlmProviderAdapter,
} from '@wispace/llm-agent/core';
import {
  ReportScheduleService,
  ReportSendScheduleService,
  ReportCronLeaderService,
  ReportCronLockService,
  CronLeaderHeartbeatService,
  ReportOrchestrationService,
  PlatformReportClaimRepository,
  PlatformReportSendJobRepository,
  ReportClaimStaleResetCronService,
} from '@wispace/scheduler-core/adapters';
import {
  CanonicalPlatformService,
  WebActivityService,
  ReportSendJobEntity,
  ScheduledReportClaimEntity,
  LearnerScheduledReportClaimEntity,
  buildLearnerUsageQuery,
  buildLegacyLearnerUsageQuery,
  CronLeaderLeaseEntity,
  CronLeaderLeaseService,
} from '@wispace/database';
import {
  CANONICAL_PLATFORM,
  ADVISORY_LOCK_PORT,
  REPORT_CRON_LEADER,
  REPORT_CRON_LOCK,
  REPORT_ORCHESTRATION,
  REPORT_SCHEDULE,
  WEB_ACTIVITY,
} from './domain/ports/report-cron-seams.port';
import {
  REPORT_SEND_JOB_REPOSITORY,
  REPORT_CLAIM_REPOSITORY,
  REPORT_DELIVERY_METRICS,
  GOALS_DATA_PORT,
  parseExamDateToIso,
  type ReportClaimRepositoryPort,
} from '@wispace/scheduler-core/core';
import {
  MemoizedWispaceGoalsService,
  WispaceDataCache,
} from '@wispace/wispace-client/core';
import { WispaceGoalsService } from '@wispace/wispace-client/adapters';
import { DiscordAccountLinkEntity } from '../../infrastructure/database/entities/discord-account-link.entity';
import { DiscordReportDeliveryService } from './application/services/discord-report-delivery.service';
import { TypeormDiscordReportAccountReader } from './infrastructure/persistence/typeorm-discord-report-account.reader';
import { DISCORD_REPORT_ACCOUNT_READER } from './domain/ports/discord-report-account-reader.port';
import { DISCORD_REPORT_GENERATOR } from './domain/ports/discord-report-generator.port';
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
      LearnerScheduledReportClaimEntity,
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
      learnerUsageQuery: buildLearnerUsageQuery,
      legacyLearnerUsageQuery: buildLegacyLearnerUsageQuery,
    }),
  ],
  providers: [
    // #549 — shadows forPlatform's unwired recorder with the metrics-wired one.
    provideWiredUsageRecorder('discord', BotMetricsService),
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
      useFactory: (repo: Repository<ReportSendJobEntity>) =>
        new PlatformReportSendJobRepository('discord', repo),
      inject: [getRepositoryToken(ReportSendJobEntity)],
    },
    {
      provide: REPORT_CLAIM_REPOSITORY,
      useFactory: (
        repo: Repository<ScheduledReportClaimEntity>,
        learnerRepo: Repository<LearnerScheduledReportClaimEntity>,
      ) => new PlatformReportClaimRepository('discord', repo, learnerRepo),
      inject: [
        getRepositoryToken(ScheduledReportClaimEntity),
        getRepositoryToken(LearnerScheduledReportClaimEntity),
      ],
    },
    {
      provide: ReportClaimStaleResetCronService,
      useFactory: (
        claimRepository: ReportClaimRepositoryPort,
        pgLock: PgAdvisoryLockService,
        reportSendScheduleService: ReportSendScheduleService,
        metrics: BotMetricsService,
      ) =>
        new ReportClaimStaleResetCronService(
          claimRepository,
          pgLock,
          reportSendScheduleService,
          {
            platform: 'discord',
            lockId: DISCORD_REPORT_CLAIM_STALE_RESET_LOCK,
            metrics,
          },
        ),
      inject: [
        REPORT_CLAIM_REPOSITORY,
        PgAdvisoryLockService,
        ReportSendScheduleService,
        BotMetricsService,
      ],
    },
    {
      provide: PlatformStudentReportService,
      useFactory: (
        configService: ConfigService,
        goalsService: MemoizedWispaceGoalsService,
        usageRecorder: PlatformLlmUsageRecorderAdapter,
        adapter: LlmProviderAdapter,
        metrics: BotMetricsService,
        executionPort: LlmExecutionPort,
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
          executionPort,
        ),
      inject: [
        ConfigService,
        MemoizedWispaceGoalsService,
        PlatformLlmUsageRecorderAdapter,
        'LLM_PROVIDER_ADAPTER',
        BotMetricsService,
        'LLM_REPORT_EXECUTION_PORT',
      ],
    },
    {
      // #1088: the orchestration service depends on the generator seam; the
      // concrete adapter stays available for its other consumers.
      provide: DISCORD_REPORT_GENERATOR,
      useExisting: PlatformStudentReportService,
    },
    ReportScheduleService,
    ReportSendScheduleService,
    CronLeaderLeaseService,
    {
      provide: ReportCronLeaderService,
      useFactory: (
        configService: ConfigService,
        leaseService: CronLeaderLeaseService,
      ) => new ReportCronLeaderService(configService, leaseService, 'discord'),
      inject: [ConfigService, CronLeaderLeaseService],
    },
    {
      provide: CronLeaderHeartbeatService,
      useFactory: (
        leaderService: ReportCronLeaderService,
        metrics: BotMetricsService,
      ) => new CronLeaderHeartbeatService(leaderService, metrics),
      inject: [ReportCronLeaderService, BotMetricsService],
    },
    {
      provide: ReportCronLockService,
      useFactory: (pgLock: PgAdvisoryLockService) =>
        new ReportCronLockService(pgLock, 'discord'),
      inject: [PgAdvisoryLockService],
    },
    { provide: REPORT_CRON_LEADER, useExisting: ReportCronLeaderService },
    { provide: REPORT_CRON_LOCK, useExisting: ReportCronLockService },
    { provide: REPORT_SCHEDULE, useExisting: ReportScheduleService },
    { provide: CANONICAL_PLATFORM, useExisting: CanonicalPlatformService },
    { provide: WEB_ACTIVITY, useExisting: WebActivityService },
    { provide: REPORT_ORCHESTRATION, useExisting: ReportOrchestrationService },
    { provide: ADVISORY_LOCK_PORT, useExisting: PgAdvisoryLockService },
    ReportOrchestrationService,
    {
      // Report-delivery SLO outcomes (#829) — BotMetricsService satisfies the
      // structural port; the orchestration counts sent/failed per send.
      provide: REPORT_DELIVERY_METRICS,
      useExisting: BotMetricsService,
    },
    DiscordReportDeliveryService,
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
