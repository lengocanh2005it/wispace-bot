import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Platform } from '@wispace/contracts';
import {
  StudyReminderScheduleService,
  StudyReminderSyncService,
  StudyReminderDispatchService,
  StudyReminderWorkerService,
  StudyReminderJobEntity,
  TypeormStudyReminderJobRepository,
  MAPPING_READER,
  MESSAGE_SENDER,
  STUDY_REMINDER_JOB_REPOSITORY,
  DISPATCH_HOOKS,
  DORMANT_REASON,
  createStudyReminderProviders,
  createSessionSourceGetSessions,
  GET_SESSIONS,
  type MappingReaderPort,
  type MessageSenderPort,
  type DispatchHooksPort,
  type StudyReminderJobStatus,
} from '@wispace/study-reminder-shared';
import { CommonModule } from '../../shared/common/common.module';
import { ADVISORY_LOCK } from '../../shared/common/advisory-lock-ids';
import { UserEntity } from '../../infrastructure/database/entities/user.entity';
import { MESSENGER_REPOSITORY } from '../messenger/domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '../messenger/domain/repositories/messenger-mapping.repository.port';
import { MessengerOutboundModule } from '../messenger/messenger-outbound.module';
import { MessengerOutboundService } from '../messenger/application/services/messenger-outbound.service';
import { StudentReportModule } from '../student-report/student-report.module';
import { WispaceModule } from '../wispace/wispace.module';
import { MemoizedWispaceGoalsService } from '@wispace/wispace-client';
import { LlmExecutionModule } from '../llm-execution/llm-execution.module';
import { LlmUsageModule } from '../llm-usage/llm-usage.module';
import { DisplayNameModule } from '../display-name/display-name.module';
import { BotMetricsService } from '@wispace/bot-metrics';
import {
  CanonicalPlatformService,
  WebActivityService,
} from '@wispace/database';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { StudyCalendarCommandService } from './application/services/study-calendar-command.service';
import { StudyReminderService } from './application/services/study-reminder.service';
import { StudySessionSourceService } from './application/services/study-session-source.service';
import { UserCalendarScheduleService } from './infrastructure/wispace/user-calendar-schedule.service';
import { UserCalendarApiService } from './infrastructure/wispace/user-calendar-api.service';
import type { UserCalendarDataPort } from './domain/ports/user-calendar-data.port';
import type { ReminderStudentDataPort } from './domain/ports/reminder-student-data.port';
import { USER_CALENDAR_DATA_PORT } from './domain/ports/user-calendar-data.port';
import { REMINDER_STUDENT_DATA_PORT } from './domain/ports/reminder-student-data.port';
import { classifyMessengerDispatchFailure } from './application/utils/study-reminder-dispatch.hooks';
import { DEFAULT_TOPIC } from '@messenger/shared/config/poc.constants';
import { STUDY_REMINDER_OPERATIONS_PORT } from './domain/ports/study-reminder-operations.port';
import type { StudyReminderOperationsPort } from './domain/ports/study-reminder-operations.port';
import { TaskScoreAverageApiService } from '../student-report/infrastructure/wispace/task-score-average-api.service';

const MESSENGER_STALE_CANCEL_STATUSES: StudyReminderJobStatus[] = [
  'pending',
  'failed',
  'processing',
];

@Module({
  imports: [
    CommonModule,
    TypeOrmModule.forFeature([StudyReminderJobEntity, UserEntity]),
    MessengerOutboundModule,
    StudentReportModule,
    WispaceModule,
    LlmExecutionModule,
    LlmUsageModule,
    DisplayNameModule,
    DatabaseModule,
  ],
  providers: [
    // ── Shared package wiring (@wispace/study-reminder-shared) ────────────
    // Provides MESSAGE_SENDER (wrapMessageSender(MessengerOutboundService)),
    // MAPPING_READER (custom via mappingReader), STUDY_REMINDER_JOB_REPOSITORY,
    // StudyReminderWorkerService + TypeormStudyReminderJobRepository.
    // The custom Schedule/Sync/Dispatch providers below are registered after
    // this spread and override the shared plain-class defaults (NestJS: last
    // provider for a token wins).
    ...createStudyReminderProviders({
      platform: 'messenger',
      outboundService: MessengerOutboundService,
      canonicalPlatformService: CanonicalPlatformService,
      mappingReader: {
        provide: MAPPING_READER,
        useFactory: (
          repository: MessengerMappingRepositoryPort,
        ): MappingReaderPort => ({
          findActiveMappingsPage: (platform, query) =>
            repository
              .findActiveMappingsPage(Number(query.afterId ?? 0), query.limit)
              .then((list) => ({
                items: list
                  .filter((m) => m.psid)
                  .map((m) => ({
                    externalUserId: m.psid as string,
                    userId: m.userId,
                    platform: platform as Platform,
                  })),
                nextId:
                  list.length > 0
                    ? String(list[list.length - 1].id)
                    : undefined,
              })),
          findActiveMappingByExternalUserId: (platform, externalUserId) =>
            repository.findActiveMappingByPsid(externalUserId).then((m) =>
              m?.psid
                ? {
                    externalUserId: m.psid,
                    userId: m.userId,
                    platform: platform as Platform,
                  }
                : null,
            ),
          getMappingState: (_platform, externalUserId) =>
            repository.findMappingStateByPsid(externalUserId),
        }),
        inject: [MESSENGER_REPOSITORY],
      },
      workerLockIds: {
        sync: ADVISORY_LOCK.STUDY_REMINDER_SYNC,
        cleanup: ADVISORY_LOCK.STUDY_REMINDER_CLEANUP,
        rollover: ADVISORY_LOCK.STUDY_REMINDER_ROLLOVER,
      },
      workerOptions: { logLockSkips: true, startupSyncSwallowErrors: true },
    }),

    {
      // Worker session source — structural bridge over the messenger-local
      // StudySessionSourceService (psid-based upcoming sessions, #424).
      provide: GET_SESSIONS,
      useFactory: (sessionSource: StudySessionSourceService) =>
        createSessionSourceGetSessions(sessionSource),
      inject: [StudySessionSourceService],
    },

    // ── Messenger-local services (kept) ──────────────────────────────────
    UserCalendarApiService,
    UserCalendarScheduleService,
    {
      provide: USER_CALENDAR_DATA_PORT,
      useFactory: (
        calendarApi: UserCalendarApiService,
        calendarSchedule: UserCalendarScheduleService,
      ): UserCalendarDataPort => ({
        listCalendars: (psid) => calendarApi.listCalendars(psid),
        createCalendar: (psid, input, options) =>
          calendarApi.createCalendar(psid, input, options),
        deleteCalendar: (psid, calendarId) =>
          calendarApi.deleteCalendar(psid, calendarId),
        getCalendarSessions: (psid, horizonEnd, options) =>
          calendarSchedule.getCalendarSessions(psid, horizonEnd, options),
        findCalendarRecord: (psid, calendarId) =>
          calendarSchedule.findCalendarRecord(psid, calendarId),
      }),
      inject: [UserCalendarApiService, UserCalendarScheduleService],
    },
    {
      provide: REMINDER_STUDENT_DATA_PORT,
      useFactory: (
        memoizedGoals: MemoizedWispaceGoalsService,
        taskScoreAverageApi: TaskScoreAverageApiService,
      ): ReminderStudentDataPort => ({
        getUserGoals: (psid) => memoizedGoals.getUserGoals(psid),
        getCapacityData: (psid) => taskScoreAverageApi.getCapacityData(psid),
      }),
      inject: [MemoizedWispaceGoalsService, TaskScoreAverageApiService],
    },
    StudyCalendarCommandService,
    StudySessionSourceService,
    StudyReminderService,

    {
      // Strict mode: missing STUDY_REMINDER_* vars fail startup (AGENTS.md).
      // Timezone key order matches resolveAppTimezone (CHAT → LLM → STUDY_REMINDER).
      provide: StudyReminderScheduleService,
      useFactory: (configService: ConfigService) =>
        new StudyReminderScheduleService(configService, {
          strict: true,
          timezoneEnvKeys: [
            'CHAT_USAGE_TIMEZONE',
            'LLM_USAGE_TIMEZONE',
            'STUDY_REMINDER_TIMEZONE',
          ],
        }),
      inject: [ConfigService],
    },

    {
      provide: DISPATCH_HOOKS,
      useFactory: (
        reminderService: StudyReminderService,
        metrics: BotMetricsService,
      ): DispatchHooksPort => ({
        generateReminder: (session, ctx) =>
          reminderService.generateReminderForSession(
            ctx.externalUserId,
            {
              sessionKey: session.sessionKey,
              scheduledAt: session.scheduledAt,
              topic: session.topic ?? DEFAULT_TOPIC,
            },
            { userId: ctx.userId, jobId: ctx.jobId },
          ),
        onSent: () => metrics.incReminderDispatch('sent'),
        onFailed: () => metrics.incReminderDispatch('failed'),
        onRetried: () => metrics.incReminderDispatch('retried'),
        onCancelled: (ctx) => {
          metrics.incReminderDispatch('cancelled');
          if (ctx.reason === DORMANT_REASON) {
            metrics.incScheduledSendSuppressed('reminder');
          }
        },
      }),
      inject: [StudyReminderService, BotMetricsService],
    },

    {
      provide: StudyReminderSyncService,
      useFactory: (
        mappingReader: MappingReaderPort,
        jobRepository: TypeormStudyReminderJobRepository,
        scheduleService: StudyReminderScheduleService,
        canonicalPlatformService: CanonicalPlatformService,
      ) =>
        new StudyReminderSyncService(
          mappingReader,
          jobRepository,
          scheduleService,
          (userId, platform) =>
            jobRepository.cancelJobsFromOtherPlatforms(userId, platform, {
              statuses: MESSENGER_STALE_CANCEL_STATUSES,
            }),
          (userId) =>
            canonicalPlatformService.getCanonicalPlatformForUser(userId),
        ),
      inject: [
        MAPPING_READER,
        STUDY_REMINDER_JOB_REPOSITORY,
        StudyReminderScheduleService,
        CanonicalPlatformService,
      ],
    },

    {
      provide: StudyReminderDispatchService,
      useFactory: (
        jobRepository: TypeormStudyReminderJobRepository,
        messageSender: MessageSenderPort,
        scheduleService: StudyReminderScheduleService,
        hooks: DispatchHooksPort,
        sessionSource: StudySessionSourceService,
        reminderService: StudyReminderService,
        mappingReader: MappingReaderPort,
        webActivity: WebActivityService,
      ) =>
        new StudyReminderDispatchService(
          jobRepository,
          messageSender,
          scheduleService,
          'messenger',
          hooks,
          {
            getMappingState: async (externalUserId) => {
              if (mappingReader.getMappingState) {
                return mappingReader.getMappingState(
                  'messenger',
                  externalUserId,
                );
              }
              return (await mappingReader.findActiveMappingByExternalUserId(
                'messenger',
                externalUserId,
              ))
                ? 'active'
                : null;
            },
            backoffMode: 'flat',
            preloadDisplayNames: (userIds) =>
              reminderService.preloadDisplayNames(userIds),
            classifyFailure: ({ error, job }) =>
              classifyMessengerDispatchFailure({
                error,
                externalUserId: job.externalUserId,
                jobId: job.id,
                retryCount: job.retryCount,
                maxRetries: job.maxRetries,
              }),
            filterDormantUserIds: (ids) => webActivity.filterDormant(ids),
          },
        ),
      inject: [
        STUDY_REMINDER_JOB_REPOSITORY,
        MESSAGE_SENDER,
        StudyReminderScheduleService,
        DISPATCH_HOOKS,
        StudySessionSourceService,
        StudyReminderService,
        MAPPING_READER,
        WebActivityService,
      ],
    },

    // ── Operations port (messenger-facing seam) ───────────────────────────
    {
      provide: STUDY_REMINDER_OPERATIONS_PORT,
      useFactory: (
        sessionSource: StudySessionSourceService,
        reminderService: StudyReminderService,
        calendarCommand: StudyCalendarCommandService,
        scheduleService: StudyReminderScheduleService,
      ): StudyReminderOperationsPort => ({
        getUpcomingSessions: (params) =>
          sessionSource.getUpcomingSessions(params),
        getNextUpcomingSession: (psid, userId?) =>
          reminderService.getNextUpcomingSession(psid, userId),
        generateReminderBundleForSession: (psid, session, options?) =>
          reminderService.generateReminderBundleForSession(
            psid,
            session,
            options,
          ),
        listEntries: (psid, userId?, options?) =>
          calendarCommand.listEntries(psid, userId, options),
        getOutboxSettings: () => scheduleService.getOutboxSettings(),
        formatScheduledTimeLabel: (scheduledAt, now?) =>
          scheduleService.formatScheduledTimeLabel(scheduledAt, now),
        rescheduleSession: (params) =>
          calendarCommand.rescheduleSession({
            psid: params.psid,
            userId: params.userId,
            calendarId: params.calendarId,
            schedulingMode: params.schedulingMode,
            newLocalDate: params.newLocalDate,
            newTime: params.newTime,
          }),
      }),
      inject: [
        StudySessionSourceService,
        StudyReminderService,
        StudyCalendarCommandService,
        StudyReminderScheduleService,
      ],
    },
  ],
  exports: [
    StudyReminderService,
    StudyReminderScheduleService,
    StudyReminderWorkerService,
    StudyReminderSyncService,
    StudyReminderDispatchService,
    StudySessionSourceService,
    StudyCalendarCommandService,
    STUDY_REMINDER_JOB_REPOSITORY,
    STUDY_REMINDER_OPERATIONS_PORT,
  ],
})
export class StudyReminderModule {}
