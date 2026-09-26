import { Module } from '@nestjs/common';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { join } from 'path';
import { PlatformStudentReportService } from '@wispace/student-report/adapters';
import {
  ChatMeteringModule,
  PlatformLlmUsageRecorderAdapter,
  LlmUsageEventEntity,
  provideWiredUsageRecorder,
} from '@wispace/chat-metering/adapters';
import { BotMetricsService } from '@wispace/bot-metrics';
import type {
  LlmExecutionPort,
  LlmProviderAdapter,
} from '@wispace/llm-agent/core';
import {
  MemoizedWispaceGoalsService,
  WispaceDataCache,
} from '@wispace/wispace-client/core';
import { WispaceGoalsService } from '@wispace/wispace-client/adapters';
import {
  GOALS_DATA_PORT,
  REPORT_CLAIM_REPOSITORY,
  REPORT_DELIVERY_PORT,
  REPORT_DELIVERY_METRICS,
  parseExamDateToIso,
  type ReportClaimRepositoryPort,
} from '@wispace/scheduler-core/core';
import {
  ReportScheduleService,
  ReportSendScheduleService,
  ReportOrchestrationService,
  CronLeaderHeartbeatService,
  ReportCronLeaderService,
  ReportCronLockService,
  PlatformReportClaimRepository,
  ReportClaimStaleResetCronService,
} from '@wispace/scheduler-core/adapters';
import { ZaloAccountLinkEntity } from '../../infrastructure/database/entities/zalo-account-link.entity';
import {
  CronLeaderLeaseEntity,
  CronLeaderLeaseService,
  ScheduledReportClaimEntity,
  LearnerScheduledReportClaimEntity,
  buildLearnerUsageQuery,
  buildLegacyLearnerUsageQuery,
} from '@wispace/database';
import { BotCommonModule } from '@wispace/bot-common/guard';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { ZaloChatModule } from './zalo-chat.module';
import { ZaloOauthModule } from '../zalo-oauth/zalo-oauth.module';
import { ZaloWispaceModule } from '../wispace/zalo-wispace.module';
import { ZaloReportCronService } from './infrastructure/persistence/zalo-report-cron.service';
import { ZaloReportDeliveryService } from './application/services/zalo-report-delivery.service';

const ZALO_REPORT_CLAIM_STALE_RESET_LOCK = 884_200_936;

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ZaloAccountLinkEntity,
      ScheduledReportClaimEntity,
      LearnerScheduledReportClaimEntity,
      LlmUsageEventEntity,
      CronLeaderLeaseEntity,
    ]),
    ZaloChatModule,
    ZaloOauthModule,
    ZaloWispaceModule,
    DatabaseModule,
    BotCommonModule,
    ChatMeteringModule.forPlatform('zalo', {
      learnerUsageQuery: buildLearnerUsageQuery,
      legacyLearnerUsageQuery: buildLegacyLearnerUsageQuery,
    }),
  ],
  providers: [
    ZaloReportCronService,
    ZaloReportDeliveryService,
    // #549 — shadows forPlatform's unwired recorder with the metrics-wired one.
    provideWiredUsageRecorder('zalo', BotMetricsService),
    {
      provide: REPORT_DELIVERY_PORT,
      useExisting: ZaloReportDeliveryService,
    },
    ReportSendScheduleService,
    ReportOrchestrationService,
    {
      // Report-delivery SLO outcomes (#829) — BotMetricsService satisfies the
      // structural port; the orchestration counts sent/failed per send.
      provide: REPORT_DELIVERY_METRICS,
      useExisting: BotMetricsService,
    },
    // Request-scoped goals memoization: exam-window check and report
    // generation both fetch goals within one execution — one upstream call
    // (TTL from the central #636 policy).
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
    ReportScheduleService,
    // #510: platform-scoped report-cron coordination — Zalo previously ran
    // the 08:00 batch with no advisory lock or leader lease at all.
    CronLeaderLeaseService,
    {
      provide: ReportCronLeaderService,
      useFactory: (
        configService: ConfigService,
        leaseService: CronLeaderLeaseService,
      ) => new ReportCronLeaderService(configService, leaseService, 'zalo'),
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
        new ReportCronLockService(pgLock, 'zalo'),
      inject: [PgAdvisoryLockService],
    },
    {
      provide: REPORT_CLAIM_REPOSITORY,
      useFactory: (
        repo: Repository<ScheduledReportClaimEntity>,
        learnerRepo: Repository<LearnerScheduledReportClaimEntity>,
      ) => new PlatformReportClaimRepository('zalo', repo, learnerRepo),
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
            platform: 'zalo',
            lockId: ZALO_REPORT_CLAIM_STALE_RESET_LOCK,
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
          'zalo',
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
  ],
  exports: [ZaloReportCronService],
})
export class ZaloReportModule {}
