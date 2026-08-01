import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  REMINDER_GENERATOR,
  METRICS_HOOK,
  ERROR_CLASSIFIER,
  type ReminderGeneratorPort,
  type MetricsHook,
  type ErrorClassifierPort,
} from '@wispace/study-reminder-shared';
import { CommonModule } from '../../shared/common/common.module';
import { StudyReminderJobEntity } from '../../infrastructure/database/entities/study-reminder-job.entity';
import { UserEntity } from '../../infrastructure/database/entities/user.entity';
import { MessengerOutboundModule } from '../messenger/messenger-outbound.module';
import { StudentReportModule } from '../student-report/student-report.module';
import { LlmExecutionModule } from '../llm-execution/llm-execution.module';
import { LlmUsageModule } from '../llm-usage/llm-usage.module';
import { StudyCalendarCommandService } from './application/services/study-calendar-command.service';
import { StudyReminderDispatchService } from './application/services/study-reminder-dispatch.service';
import { StudyReminderSyncService } from './application/services/study-reminder-sync.service';
import { StudyReminderWorkerService } from './application/services/study-reminder-worker.service';
import { StudyReminderService } from './application/services/study-reminder.service';
import { StudySessionSourceService } from './application/services/study-session-source.service';
import { StudyReminderScheduleService } from './application/services/study-reminder-schedule.service';
import { UserDisplayNameService } from './application/services/user-display-name.service';
import { USER_DISPLAY_NAME_CACHE } from './domain/repositories/user-display-name-cache.port';
import { STUDY_REMINDER_JOB_REPOSITORY } from './domain/repositories/study-reminder-job.repository.port';
import { RedisUserDisplayNameCache } from './infrastructure/cache/redis-user-display-name.cache';
import { UserCalendarScheduleService } from './infrastructure/wispace/user-calendar-schedule.service';
import { UserCalendarApiService } from './infrastructure/wispace/user-calendar-api.service';
import { StudyReminderJobRepository } from './infrastructure/persistence/study-reminder-job.repository';
import { MessengerReminderGeneratorAdapter } from './infrastructure/adapters/messenger-reminder-generator.adapter';
import { MessengerReminderMetricsHook } from './infrastructure/adapters/messenger-metrics-hook.adapter';
import { MessengerErrorClassifierAdapter } from './infrastructure/adapters/messenger-error-classifier.adapter';
import { MetricsService } from '../metrics/metrics.service';

@Module({
  imports: [
    CommonModule,
    TypeOrmModule.forFeature([StudyReminderJobEntity, UserEntity]),
    MessengerOutboundModule,
    StudentReportModule,
    LlmExecutionModule,
    LlmUsageModule,
  ],
  providers: [
    // ── Existing Messenger services ──────────────────────────────────────
    UserCalendarApiService,
    UserCalendarScheduleService,
    StudyCalendarCommandService,
    StudySessionSourceService,
    StudyReminderService,
    UserDisplayNameService,
    RedisUserDisplayNameCache,
    {
      provide: USER_DISPLAY_NAME_CACHE,
      useExisting: RedisUserDisplayNameCache,
    },

    // ── Local job repository (Messenger-specific: psid, advisory lock) ───
    StudyReminderJobRepository,
    {
      provide: STUDY_REMINDER_JOB_REPOSITORY,
      useExisting: StudyReminderJobRepository,
    },

    // ── Local schedule service (full shape: maxRetries, retryBackoffMinutes) ─
    StudyReminderScheduleService,

    // ── Local dispatch service (uses local MESSAGE_SENDER from MessengerOutboundModule) ─
    StudyReminderDispatchService,
    {
      provide: REMINDER_GENERATOR,
      useFactory: (sr: StudyReminderService): ReminderGeneratorPort =>
        new MessengerReminderGeneratorAdapter(sr),
      inject: [StudyReminderService],
    },
    {
      provide: METRICS_HOOK,
      useFactory: (m: MetricsService): MetricsHook =>
        new MessengerReminderMetricsHook(m),
      inject: [MetricsService],
    },
    {
      provide: ERROR_CLASSIFIER,
      useFactory: (): ErrorClassifierPort =>
        new MessengerErrorClassifierAdapter(),
      inject: [],
    },
    StudyReminderDispatchService,

    // ── Local worker and sync (Messenger-specific: PgAdvisoryLock, psid) ─
    StudyReminderSyncService,
    StudyReminderWorkerService,
  ],
  exports: [
    StudyReminderService,
    StudyReminderScheduleService,
    StudyReminderWorkerService,
    StudyReminderSyncService,
    StudyReminderDispatchService,
    StudySessionSourceService,
    StudyCalendarCommandService,
    UserCalendarApiService,
    UserDisplayNameService,
    STUDY_REMINDER_JOB_REPOSITORY,
  ],
})
export class StudyReminderModule {}
