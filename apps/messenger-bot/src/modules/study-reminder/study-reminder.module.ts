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
import { PlatformStudyCalendarCommandService } from '@wispace/study-reminder-shared/adapters';
import { CommonModule } from '../../shared/common/common.module';
import { APP_TIMEZONE_ENV_KEYS } from '../../shared/config/app-timezone';
import { ADVISORY_LOCK } from '../../shared/common/advisory-lock-ids';
import { UserEntity } from '../../infrastructure/database/entities/user.entity';
import { MESSENGER_REPOSITORY } from '../messenger/domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '../messenger/domain/repositories/messenger-mapping.repository.port';
import { MessengerOutboundModule } from '../messenger/messenger-outbound.module';
import { MessengerOutboundService } from '../messenger/application/services/messenger-outbound.service';
import { StudentReportModule } from '../student-report/student-report.module';
import { WispaceModule } from '../wispace/wispace.module';
import {
  MemoizedWispaceGoalsService,
  WispaceCalendarService,
} from '@wispace/wispace-client';
import { LlmExecutionModule } from '../llm-execution/llm-execution.module';
import { LlmUsageModule } from '../llm-usage/llm-usage.module';
import { DisplayNameModule } from '../display-name/display-name.module';
import { BotMetricsService } from '@wispace/bot-metrics';
import {
  CanonicalPlatformService,
  WebActivityService,
} from '@wispace/database';
import type { LlmUsageRecorderPort } from '@wispace/llm-agent';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { StudyCalendarCommandService } from './infrastructure/adapters/study-calendar-command.service';
import { StudyReminderService } from './application/services/study-reminder.service';
import { StudySessionSourceService } from './application/services/study-session-source.service';
import { UserCalendarScheduleService } from './infrastructure/wispace/user-calendar-schedule.service';
import { UserCalendarApiService } from './infrastructure/wispace/user-calendar-api.service';
import type { ReminderStudentDataPort } from './domain/ports/reminder-student-data.port';
import { REMINDER_STUDENT_DATA_PORT } from './domain/ports/reminder-student-data.port';
import { classifyMessengerDispatchFailure } from '../messenger/application/utils/messenger-study-reminder-failure.utils';
import { DEFAULT_TOPIC } from '@messenger/shared/config/poc.constants';
import {
  STUDY_REMINDER_OPERATIONS_PORT,
  type StudyReminderOperationsPort,
} from './domain/ports/study-reminder-operations.port';
import {
  STUDY_REMINDER_SYNC_PORT,
  type StudyReminderSyncPort,
} from './domain/ports/study-reminder-sync.port';
import {
  STUDY_REMINDER_DISPLAY_NAME_PORT,
  type StudyReminderDisplayNamePort,
} from './domain/ports/study-reminder-display-name.port';
import {
  STUDY_REMINDER_LLM_EXECUTION_PORT,
  STUDY_REMINDER_LLM_USAGE_RECORDER_PORT,
} from './domain/ports/study-reminder-llm.port';
import { TaskScoreAverageApiService } from '../student-report/infrastructure/wispace/task-score-average-api.service';
import { LlmExecutionService } from '../llm-execution/application/services/llm-execution.service';
import { LlmUsageRecorderService } from '../llm-usage/application/services/llm-usage-recorder.service';
import type { LlmUsageFeature } from '../llm-usage/domain/entities/llm-usage.types';
import { UserDisplayNameService } from '../display-name/application/user-display-name.service';

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
                    mappingGeneration: m.mappingGeneration,
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
                    mappingGeneration: m.mappingGeneration,
                  }
                : null,
            ),
          getMappingState: async (_platform, externalUserId) => {
            const state =
              await repository.findMappingStateByPsid(externalUserId);
            if (state !== 'active') {
              return state ? { state } : null;
            }
            const mapping =
              await repository.findActiveMappingByPsid(externalUserId);
            return mapping?.userId != null && mapping.mappingGeneration
              ? {
                  state: 'active',
                  userId: mapping.userId,
                  mappingGeneration: mapping.mappingGeneration,
                }
              : null;
          },
        }),
        inject: [MESSENGER_REPOSITORY],
      },
      workerLockIds: {
        sync: ADVISORY_LOCK.STUDY_REMINDER_SYNC,
        cleanup: ADVISORY_LOCK.STUDY_REMINDER_CLEANUP,
        rollover: ADVISORY_LOCK.STUDY_REMINDER_ROLLOVER,
      },
      workerOptions: { logLockSkips: true, startupSyncSwallowErrors: true },
      workerMetrics: BotMetricsService,
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
    {
      provide: PlatformStudyCalendarCommandService,
      useFactory: (
        calendarService: WispaceCalendarService,
        scheduleService: StudyReminderScheduleService,
      ) =>
        new PlatformStudyCalendarCommandService(
          { platform: 'messenger', enforceLeadTime: true },
          calendarService,
          {
            getTimezone: () => scheduleService.getOutboxSettings().timezone,
            getMinLeadMinutes: () =>
              scheduleService.getOutboxSettings().minLeadMinutes,
          },
        ),
      inject: [WispaceCalendarService, StudyReminderScheduleService],
    },
    StudyCalendarCommandService,
    StudySessionSourceService,
    StudyReminderService,

    {
      provide: STUDY_REMINDER_LLM_EXECUTION_PORT,
      useExisting: LlmExecutionService,
    },
    {
      provide: STUDY_REMINDER_LLM_USAGE_RECORDER_PORT,
      useFactory: (
        recorder: LlmUsageRecorderService,
      ): LlmUsageRecorderPort => ({
        recordFromCompletion: (input) =>
          recorder.recordFromCompletion({
            feature: input.feature as LlmUsageFeature,
            psid: input.externalUserId,
            userId: input.userId,
            provider: input.provider,
            model: input.model,
            response: input.response,
            correlationId: input.correlationId,
            toolRound: input.toolRound,
          }),
      }),
      inject: [LlmUsageRecorderService],
    },
    {
      provide: STUDY_REMINDER_DISPLAY_NAME_PORT,
      useFactory: (
        displayNameService: UserDisplayNameService,
      ): StudyReminderDisplayNamePort => ({
        resolveDisplayName: ({ userId, externalUserId }) =>
          displayNameService.resolveDisplayName({
            userId,
            psid: externalUserId,
          }),
        preloadDisplayNames: (userIds) =>
          displayNameService.preloadDisplayNames(userIds),
      }),
      inject: [UserDisplayNameService],
    },

    {
      // Strict mode: missing STUDY_REMINDER_* vars fail startup (AGENTS.md).
      // Timezone key order matches resolveAppTimezone (CHAT → LLM → STUDY_REMINDER).
      provide: StudyReminderScheduleService,
      useFactory: (configService: ConfigService) =>
        new StudyReminderScheduleService(configService, {
          strict: true,
          timezoneEnvKeys: [...APP_TIMEZONE_ENV_KEYS],
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
          metrics.incReminderDispatch(
            ctx.reason === 'mapping_ownership_changed'
              ? 'cancelled_ownership_changed'
              : ctx.reason === 'link_revoked'
                ? 'cancelled_link_revoked'
                : ctx.reason === 'mapping_generation_missing'
                  ? 'cancelled_mapping_generation_missing'
                  : 'cancelled',
          );
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
        messengerRepository: MessengerMappingRepositoryPort,
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
          (userId) =>
            messengerRepository
              .findActiveMappingByUserId(userId)
              .then((mapping) =>
                mapping?.psid
                  ? {
                      externalUserId: mapping.psid,
                      userId: mapping.userId,
                      platform: 'messenger' as const,
                      mappingGeneration: mapping.mappingGeneration,
                    }
                  : null,
              ),
        ),
      inject: [
        MAPPING_READER,
        STUDY_REMINDER_JOB_REPOSITORY,
        StudyReminderScheduleService,
        CanonicalPlatformService,
        MESSENGER_REPOSITORY,
      ],
    },

    {
      provide: STUDY_REMINDER_SYNC_PORT,
      useFactory: (
        syncService: StudyReminderSyncService,
        sessionSource: StudySessionSourceService,
      ): StudyReminderSyncPort => ({
        syncForUser: async (userId) => {
          await syncService.syncUpcomingSessions({
            userId,
            // Keep the shared sync service behind one Messenger-owned seam.
            getSessions: createSessionSourceGetSessions(sessionSource),
          });
        },
      }),
      inject: [StudyReminderSyncService, StudySessionSourceService],
    },

    {
      provide: StudyReminderDispatchService,
      useFactory: (
        jobRepository: TypeormStudyReminderJobRepository,
        messageSender: MessageSenderPort,
        scheduleService: StudyReminderScheduleService,
        hooks: DispatchHooksPort,
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
              const link =
                await mappingReader.findActiveMappingByExternalUserId(
                  'messenger',
                  externalUserId,
                );
              return link?.userId != null && link.mappingGeneration
                ? {
                    state: 'active',
                    userId: link.userId,
                    mappingGeneration: link.mappingGeneration,
                  }
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
    STUDY_REMINDER_SYNC_PORT,
  ],
})
export class StudyReminderModule {}
