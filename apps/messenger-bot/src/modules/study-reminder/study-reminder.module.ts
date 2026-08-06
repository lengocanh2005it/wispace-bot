import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  REDIS_CLIENT,
  RedisUserDisplayNameCache,
  PgAdvisoryLockService,
  type RedisClientPort,
} from '@wispace/bot-common';
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
  REMINDER_GENERATOR,
  METRICS_HOOK,
  type MappingReaderPort,
  type MessageSenderPort,
  type ReminderGeneratorPort,
  type MetricsHook,
  type StudyReminderJobStatus,
} from '@wispace/study-reminder-shared';
import { CommonModule } from '../../shared/common/common.module';
import { ADVISORY_LOCK } from '../../shared/common/advisory-lock-ids';
import { UserEntity } from '../../infrastructure/database/entities/user.entity';
import {
  MESSENGER_MAPPING_READER,
  type MessengerMappingReaderPort,
} from '../../shared/ports/messenger-mapping-reader.port';
import { MessengerOutboundModule } from '../messenger/messenger-outbound.module';
import { MessengerOutboundService } from '../messenger/application/services/messenger-outbound.service';
import { StudentReportModule } from '../student-report/student-report.module';
import { LlmExecutionModule } from '../llm-execution/llm-execution.module';
import { LlmUsageModule } from '../llm-usage/llm-usage.module';
import { MetricsService } from '../metrics/metrics.service';
import { StudyCalendarCommandService } from './application/services/study-calendar-command.service';
import { StudyReminderService } from './application/services/study-reminder.service';
import { StudySessionSourceService } from './application/services/study-session-source.service';
import { UserDisplayNameService } from './application/services/user-display-name.service';
import { USER_DISPLAY_NAME_CACHE } from './domain/repositories/user-display-name-cache.port';
import { UserCalendarScheduleService } from './infrastructure/wispace/user-calendar-schedule.service';
import { UserCalendarApiService } from './infrastructure/wispace/user-calendar-api.service';
import { classifyMessengerDispatchFailure } from './application/utils/study-reminder-dispatch.hooks';
import { DEFAULT_TOPIC } from '@messenger/shared/config/poc.constants';

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
    LlmExecutionModule,
    LlmUsageModule,
  ],
  providers: [
    // ── Messenger-local services (kept) ──────────────────────────────────
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

    // ── Shared package services (adopted from @wispace/study-reminder-shared) ──
    TypeormStudyReminderJobRepository,
    {
      provide: STUDY_REMINDER_JOB_REPOSITORY,
      useExisting: TypeormStudyReminderJobRepository,
    },

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
      provide: MAPPING_READER,
      useFactory: (reader: MessengerMappingReaderPort): MappingReaderPort => ({
        findActiveMappings: (platform) =>
          reader.findActiveMappingsWithPsid().then((list) =>
            list
              .filter((m) => m.psid)
              .map((m) => ({
                externalUserId: m.psid as string,
                userId: m.userId,
                platform,
              })),
          ),
        findActiveMappingByExternalUserId: (platform, externalUserId) =>
          reader.findActiveMappingByPsid(externalUserId).then((m) =>
            m?.psid
              ? {
                  externalUserId: m.psid,
                  userId: m.userId,
                  platform,
                }
              : null,
          ),
      }),
      inject: [MESSENGER_MAPPING_READER],
    },

    {
      // MessageSenderPort adapter: keeps the messenger message log + 24h classification.
      provide: MESSAGE_SENDER,
      useFactory: (outbound: MessengerOutboundService): MessageSenderPort => ({
        sendText: (input) =>
          outbound.sendTextViaPsid({
            psid: input.externalUserId,
            text: input.text,
            messageType: input.messageType ?? 'STUDY_REMINDER',
            userId: input.userId,
          }),
      }),
      inject: [MessengerOutboundService],
    },

    {
      provide: REMINDER_GENERATOR,
      useFactory: (
        reminderService: StudyReminderService,
      ): ReminderGeneratorPort => ({
        generate: (session, ctx) =>
          reminderService.generateReminderForSession(
            ctx.externalUserId,
            {
              sessionKey: session.sessionKey,
              scheduledAt: session.scheduledAt,
              topic: session.topic ?? DEFAULT_TOPIC,
            },
            { userId: ctx.userId, jobId: ctx.jobId },
          ),
      }),
      inject: [StudyReminderService],
    },

    {
      provide: METRICS_HOOK,
      useFactory: (metrics: MetricsService): MetricsHook => ({
        onSent: () => metrics.incReminderDispatch('sent'),
        onFailed: () => metrics.incReminderDispatch('failed'),
        onRetried: () => metrics.incReminderDispatch('retried'),
        onCancelled: () => metrics.incReminderDispatch('cancelled'),
      }),
      inject: [MetricsService],
    },

    {
      provide: StudyReminderSyncService,
      useFactory: (
        mappingReader: MappingReaderPort,
        jobRepository: TypeormStudyReminderJobRepository,
        scheduleService: StudyReminderScheduleService,
      ) =>
        new StudyReminderSyncService(
          mappingReader,
          jobRepository,
          scheduleService,
          (userId, platform) =>
            jobRepository.cancelJobsFromOtherPlatforms(userId, platform, {
              statuses: MESSENGER_STALE_CANCEL_STATUSES,
            }),
        ),
      inject: [
        MAPPING_READER,
        STUDY_REMINDER_JOB_REPOSITORY,
        StudyReminderScheduleService,
      ],
    },

    {
      provide: StudyReminderDispatchService,
      useFactory: (
        jobRepository: TypeormStudyReminderJobRepository,
        messageSender: MessageSenderPort,
        scheduleService: StudyReminderScheduleService,
        reminderGenerator: ReminderGeneratorPort,
        metrics: MetricsHook,
        sessionSource: StudySessionSourceService,
        reminderService: StudyReminderService,
      ) =>
        new StudyReminderDispatchService(
          jobRepository,
          messageSender,
          scheduleService,
          reminderGenerator,
          metrics,
          undefined,
          {
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
          },
        ),
      inject: [
        STUDY_REMINDER_JOB_REPOSITORY,
        MESSAGE_SENDER,
        StudyReminderScheduleService,
        REMINDER_GENERATOR,
        METRICS_HOOK,
        StudySessionSourceService,
        StudyReminderService,
      ],
    },

    {
      provide: StudyReminderWorkerService,
      useFactory: (...deps: unknown[]) =>
        new (StudyReminderWorkerService as never as new (
          ...args: unknown[]
        ) => StudyReminderWorkerService)(
          deps[0],
          deps[1],
          deps[2],
          deps[3],
          deps[4],
          deps[5],
          'messenger',
          deps[6]
            ? (externalUserId: string, userId?: number) =>
                (deps[6] as StudySessionSourceService).getUpcomingSessions({
                  psid: externalUserId,
                  userId,
                })
            : undefined,
          {
            sync: ADVISORY_LOCK.STUDY_REMINDER_SYNC,
            cleanup: ADVISORY_LOCK.STUDY_REMINDER_CLEANUP,
            rollover: ADVISORY_LOCK.STUDY_REMINDER_ROLLOVER,
          },
          {
            logLockSkips: true,
            startupSyncSwallowErrors: true,
          },
        ),
      inject: [
        StudyReminderSyncService,
        StudyReminderDispatchService,
        StudyReminderScheduleService,
        { token: SchedulerRegistry, optional: false },
        PgAdvisoryLockService,
        { token: STUDY_REMINDER_JOB_REPOSITORY, optional: true },
        StudySessionSourceService,
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
    UserCalendarApiService,
    UserDisplayNameService,
    STUDY_REMINDER_JOB_REPOSITORY,
  ],
})
export class StudyReminderModule {}
