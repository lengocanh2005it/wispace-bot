import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { PgAdvisoryLockService } from '@wispace/bot-common';
import {
  ReportScheduleService,
  ReportSendScheduleService,
  ReportCronLeaderService,
  ReportCronLockService,
  CronLeaderHeartbeatService,
  REPORT_SEND_JOB_REPOSITORY,
  REPORT_CLAIM_REPOSITORY,
  GOALS_DATA_PORT,
  type ReportClaimRepositoryPort,
} from '@wispace/scheduler-core';
import { ReportSendJobEntity } from '@wispace/database';
import {
  CronLeaderLeaseService,
  CronLeaderLeaseEntity,
  ReportClaimStaleResetCronService,
} from '@wispace/database';
import { LlmSafetyEventEntity } from '@wispace/chat-metering';
import { CommonModule } from '../../shared/common/common.module';
import { ChatRateLimitModule } from '../chat-rate-limit/chat-rate-limit.module';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { MessengerReportModule } from '../messenger/messenger-report.module';
import { MessengerOutboundModule } from '../messenger/messenger-outbound.module';
import { UserLinkingModule } from '../messenger/user-linking.module';
import { StudentReportModule } from '../student-report/student-report.module';
import { StudyReminderModule } from '../study-reminder/study-reminder.module';
import { UserGoalsApiService } from '../student-report/infrastructure/wispace/user-goals-api.service';
import { DopplerRuntimeSyncService } from './application/services/doppler-runtime-sync.service';
import { OpsHealthCronService } from './application/services/ops-health-cron.service';
import { OpsHealthService } from './application/services/ops-health.service';
import { ReportCronService } from './application/services/report-cron.service';
import { ReportSendOrchestrationService } from './application/services/report-send-orchestration.service';
import { ReportSendRetryDispatchService } from './application/services/report-send-retry-dispatch.service';
import { ReportSendJobRepository } from './infrastructure/persistence/report-send-job.repository';
import { LlmSafetyService } from './application/services/llm-safety.service';
import { SchedulerController } from './presentation/controllers/scheduler.controller';
import { ADVISORY_LOCK } from '../../shared/common/advisory-lock-ids';

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
    MessengerOutboundModule,
    MessengerReportModule,
    UserLinkingModule,
    StudentReportModule,
    StudyReminderModule,
  ],
  controllers: [SchedulerController],
  providers: [
    {
      provide: GOALS_DATA_PORT,
      useFactory: (goalsApi: UserGoalsApiService) => ({
        getUserGoals: (psid: string) => goalsApi.getUserGoals(psid),
      }),
      inject: [UserGoalsApiService],
    },
    ReportScheduleService,
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
      ) =>
        new ReportClaimStaleResetCronService(
          configService,
          claimRepository,
          pgLock,
          {
            platform: 'messenger',
            lockId: ADVISORY_LOCK.REPORT_CLAIM_STALE_RESET,
          },
        ),
      inject: [ConfigService, REPORT_CLAIM_REPOSITORY, PgAdvisoryLockService],
    },
    {
      provide: REPORT_SEND_JOB_REPOSITORY,
      useExisting: ReportSendJobRepository,
    },
    OpsHealthService,
    OpsHealthCronService,
    DopplerRuntimeSyncService,
    LlmSafetyService,
  ],
})
export class SchedulerModule {}
