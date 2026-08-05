import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  REDIS_CLIENT,
  RedisUserDisplayNameCache,
  type RedisClientPort,
} from '@wispace/bot-common';
import { StudyReminderJobEntity } from '@wispace/study-reminder-shared';
import { CommonModule } from '../../shared/common/common.module';
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
import { UserCalendarScheduleService } from './infrastructure/wispace/user-calendar-schedule.service';
import { UserCalendarApiService } from './infrastructure/wispace/user-calendar-api.service';
import { StudyReminderJobRepository } from './infrastructure/persistence/study-reminder-job.repository';

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
    {
      provide: RedisUserDisplayNameCache,
      useFactory: (
        redisClient: RedisClientPort,
        configService: ConfigService,
      ) =>
        new RedisUserDisplayNameCache(redisClient, configService, {
          platform: 'messenger',
        }),
      inject: [REDIS_CLIENT, ConfigService],
    },
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
