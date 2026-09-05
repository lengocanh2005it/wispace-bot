import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import {
  ReportScheduleService,
  ReportSendScheduleService,
  ReportCronLeaderService,
  ReportCronLockService,
  CronLeaderHeartbeatService,
  REPORT_SEND_JOB_REPOSITORY,
  REPORT_CLAIM_REPOSITORY,
  GOALS_DATA_PORT,
  parseExamDateToIso,
  type ReportClaimRepositoryPort,
} from '@wispace/scheduler-core';
import { ReportSendJobEntity } from '@wispace/database';
import {
  CronLeaderLeaseService,
  CronLeaderLeaseEntity,
  ReportClaimStaleResetCronService,
} from '@wispace/database';
import { LlmSafetyEventEntity } from '@wispace/chat-metering';
import { BotMetricsService } from '@wispace/bot-metrics';
import {
  DataQualityService,
  TypeormDataQualityDatabase,
  TypeormDataQualityRepository,
  readDataQualityConfig,
} from '@wispace/ops-health';
import { CommonModule } from '../../shared/common/common.module';
import { ChatRateLimitModule } from '../chat-rate-limit/chat-rate-limit.module';
import { ChatPipelineModule } from '../messenger/chat-pipeline.module';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { MessengerReportModule } from '../messenger/messenger-report.module';
import { MessengerOutboundModule } from '../messenger/messenger-outbound.module';
import { UserLinkingModule } from '../messenger/user-linking.module';
import { StudentReportModule } from '../student-report/student-report.module';
import { StudyReminderModule } from '../study-reminder/study-reminder.module';
import { WispaceModule } from '../wispace/wispace.module';
import { MemoizedWispaceGoalsService } from '@wispace/wispace-client';
import { OpsHealthCronService } from './application/services/ops-health-cron.service';
import { DataQualityCronService } from './application/services/data-quality-cron.service';
import { OpsHealthService } from './application/services/ops-health.service';
import { ReportCronService } from './application/services/report-cron.service';
import { ReportSendOrchestrationService } from './application/services/report-send-orchestration.service';
import { ReportSendRetryDispatchService } from './application/services/report-send-retry-dispatch.service';
import { ReportSendJobRepository } from './infrastructure/persistence/report-send-job.repository';
import { LlmSafetyService } from './application/services/llm-safety.service';
import { SchedulerController } from './presentation/controllers/scheduler.controller';
import { ADVISORY_LOCK } from '../../shared/common/advisory-lock-ids';
import { DisplayNameModule } from '../display-name/display-name.module';

@Module({
  imports: [
    CommonModule,
    DatabaseModule,
    TypeOrmModule.forFeature([
      ReportSendJobEntity,
      LlmSafetyEventEntity,
      CronLeaderLeaseEntity,
    ]),
    ChatRateLimitModule,
    ChatPipelineModule,
    MessengerOutboundModule,
    MessengerReportModule,
    UserLinkingModule,
    StudentReportModule,
    WispaceModule,
    StudyReminderModule,
    DisplayNameModule,
  ],
  controllers: [SchedulerController],
  providers: [
    {
      provide: GOALS_DATA_PORT,
      useFactory: (memoizedGoals: MemoizedWispaceGoalsService) => ({
        getUserGoals: (psid: string) => memoizedGoals.getUserGoals(psid),
        parseExamDate: (examDate: string) => parseExamDateToIso(examDate),
      }),
      inject: [MemoizedWispaceGoalsService],
    },
    ReportScheduleService,
    CronLeaderLeaseService,
    {
      provide: ReportCronLeaderService,
      useFactory: (
        configService: ConfigService,
        leaseService: CronLeaderLeaseService,
      ) =>
        new ReportCronLeaderService(configService, leaseService, 'messenger'),
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
        new ReportCronLockService(pgLock, 'messenger'),
      inject: [PgAdvisoryLockService],
    },
    ReportSendOrchestrationService,
    ReportCronService,
    ReportSendScheduleService,
    ReportSendRetryDispatchService,
    ReportSendJobRepository,
    {
      provide: ReportClaimStaleResetCronService,
      useFactory: (
        configService: ConfigService,
        claimRepository: ReportClaimRepositoryPort,
        pgLock: PgAdvisoryLockService,
        metrics: BotMetricsService,
      ) =>
        new ReportClaimStaleResetCronService(
          configService,
          claimRepository,
          pgLock,
          {
            platform: 'messenger',
            lockId: ADVISORY_LOCK.REPORT_CLAIM_STALE_RESET,
            metrics,
          },
        ),
      inject: [
        ConfigService,
        REPORT_CLAIM_REPOSITORY,
        PgAdvisoryLockService,
        BotMetricsService,
      ],
    },
    {
      provide: REPORT_SEND_JOB_REPOSITORY,
      useExisting: ReportSendJobRepository,
    },
    {
      provide: DataQualityService,
      useFactory: (
        dataSource: DataSource,
        configService: ConfigService,
        pgLock: PgAdvisoryLockService,
        metrics: BotMetricsService,
      ) =>
        new DataQualityService(
          new TypeormDataQualityRepository(
            new TypeormDataQualityDatabase(dataSource),
          ),
          pgLock,
          readDataQualityConfig((key) => configService.get<string>(key)),
          {
            setCheckStatus: (check, status) =>
              metrics.setDataQualityCheckStatus(check, status),
            incRun: (outcome) => metrics.incDataQualityRun(outcome),
            incFailure: (check) => metrics.incDataQualityFailure(check),
          },
        ),
      inject: [
        DataSource,
        ConfigService,
        PgAdvisoryLockService,
        BotMetricsService,
      ],
    },
    OpsHealthService,
    OpsHealthCronService,
    DataQualityCronService,
    LlmSafetyService,
  ],
})
export class SchedulerModule {}
