import type { Provider } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import type { Repository } from 'typeorm';
import { GET_SESSIONS } from '../ports/get-sessions.port';
import { MESSAGE_SENDER } from '../ports/message-sender.port';
import type { MessageSenderPort } from '../ports/message-sender.port';
import {
  MAPPING_READER,
  type MappingReaderPort,
} from '../ports/mapping-reader.port';
import {
  STUDY_REMINDER_JOB_REPOSITORY,
  type StudyReminderJobRepositoryPort,
} from '../ports/study-reminder-job.repository.port';
import type { StudyCalendarPort } from '../ports/study-calendar.port';
import {
  wrapMessageSender,
  type OutboundMessageSender,
} from './message-sender.factory';
import {
  TypeormMappingReader,
  type AccountLinkRow,
} from '../infrastructure/typeorm-mapping-reader';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
import { StudyReminderSyncService } from './study-reminder-sync.service';
import {
  DORMANT_REASON,
  StudyReminderDispatchService,
} from './study-reminder-dispatch.service';
import { StudyReminderWorkerService } from './study-reminder-worker.service';
import { TypeormStudyReminderJobRepository } from '../infrastructure/typeorm-study-reminder-job.repository';
import type { GetSessionsFn } from '../types/study-reminder.types';
import type { Platform } from '@wispace/contracts';
import type {
  StudyReminderWorkerLockIds,
  StudyReminderWorkerOptions,
  StudyReminderWorkerMetrics,
} from './study-reminder-worker.service';

/** Constructor usable as a NestJS injection token, typed to its instance. */
type ClassOf<T> = new (...args: never[]) => T;

/** Any injectable outbound-sender class — `wrapMessageSender` bridges it to `MessageSenderPort`. */
type OutboundSenderCtor = new (...args: never[]) => unknown;

export interface CreateStudyReminderProvidersOptions {
  platform: Platform;
  /** Required when `mappingReader` is not provided (discord/zalo). */
  mappingTable?: string;
  /** Required when `mappingReader` is not provided (discord/zalo). */
  mappingEntity?: ClassOf<AccountLinkRow>;
  outboundService: OutboundSenderCtor;
  /** Messenger: replaces the TypeormMappingReader factory with a custom provider (backed by MESSENGER_REPOSITORY). */
  mappingReader?: Provider;
  /** Messenger: advisory lock ids for sync/cleanup/rollover (shared defaults when absent). */
  workerLockIds?: StudyReminderWorkerLockIds;
  /** Messenger: worker options (logLockSkips, startupSyncSwallowErrors). */
  workerOptions?: StudyReminderWorkerOptions;
  /** Optional per-bot metrics adapter for cron heartbeats and lock skips. */
  workerMetrics?: ClassOf<StudyReminderWorkerMetrics>;
  /** Required canonical-platform service used by every production sync worker. */
  canonicalPlatformService: ClassOf<{
    getCanonicalPlatformForUser(userId: number): Promise<Platform | undefined>;
  }>;
  /** Discord/Zalo: WebActivityService — enables the dispatch dormancy gate. */
  dormancyGate?: ClassOf<{
    filterDormant(userIds: number[]): Promise<number[]>;
  }>;
  /** Discord/Zalo: BotMetricsService — meters reminder suppression via a minimal DISPATCH_HOOKS. */
  dormancySuppressionMetric?: ClassOf<{
    incScheduledSendSuppressed(
      feature: 'reminder' | 'report',
      count?: number,
    ): void;
  }>;
}

/** Structural surface of messenger's StudySessionSourceService (no cross-app import). */
export interface GetUpcomingSessionsService {
  getUpcomingSessions(input: {
    psid: string;
    userId?: number;
  }): Promise<Array<{ sessionKey: string; scheduledAt: Date; topic?: string }>>;
}

/** Named, typed dependency set for the shared worker — replaces positional wiring. */
export interface StudyReminderWorkerDeps {
  syncService: StudyReminderSyncService;
  dispatchService: StudyReminderDispatchService;
  scheduleService: StudyReminderScheduleService;
  schedulerRegistry: SchedulerRegistry;
  pgLock: PgAdvisoryLockService;
  jobRepository?: StudyReminderJobRepositoryPort;
  getSessions?: GetSessionsFn;
}

/** Named, typed worker policy/config — platform + lock ids + worker options. */
export interface StudyReminderWorkerConfig {
  platform: Platform;
  lockIds?: Partial<StudyReminderWorkerLockIds>;
  options?: StudyReminderWorkerOptions;
}

/** Constructs the shared worker from a named deps object (typed, no positional unknowns). */
export function createStudyReminderWorker(
  deps: StudyReminderWorkerDeps,
  config: StudyReminderWorkerConfig,
): StudyReminderWorkerService {
  return new StudyReminderWorkerService(
    deps.syncService,
    deps.dispatchService,
    deps.scheduleService,
    deps.schedulerRegistry,
    deps.pgLock,
    deps.jobRepository,
    config.platform,
    deps.getSessions,
    config.lockIds,
    config.options,
  );
}

/**
 * Builds the authoritative `getSessions` provider from a WISPACE calendar
 * client (structural view — upcoming sessions). Used by the shared worker
 * and by direct sync entry points (Discord/Zalo ops controllers) so a sync
 * is never executed against an assumed-empty calendar.
 */
export function createCalendarGetSessions(
  service: Pick<StudyCalendarPort, 'getCalendarSessions'>,
): GetSessionsFn {
  return (externalUserId: string, userId?: number) =>
    service
      .getCalendarSessions(externalUserId, {
        timeRange: 'upcoming',
        userId,
      })
      .then((sessions) =>
        sessions.map((s) => ({
          calendarId: s.sessionKey,
          sessionKey: s.sessionKey,
          scheduledAt: s.scheduledAt,
          topic: s.topic,
        })),
      );
}

/**
 * Builds the authoritative `getSessions` provider from a session-source
 * service (messenger: `StudySessionSourceService` with getUpcomingSessions)
 * — used by the shared worker and by direct sync entry points (Messenger
 * ops controllers / relink) so a sync is never executed against an
 * assumed-empty calendar.
 */
export function createSessionSourceGetSessions(
  service: GetUpcomingSessionsService,
): GetSessionsFn {
  return async (externalUserId: string, userId?: number) => {
    const sessions = await service.getUpcomingSessions({
      psid: externalUserId,
      userId,
    });
    return sessions.map((s) => ({
      calendarId: s.sessionKey,
      sessionKey: s.sessionKey,
      scheduledAt: s.scheduledAt,
      topic: s.topic,
    }));
  };
}

/**
 * Shared provider wiring for study reminder sync/dispatch/worker — replaces
 * the near-identical providers arrays in the Discord and Zalo study-reminder
 * modules. Parameterized by platform, mapping table/entity and outbound
 * service; the worker's session source is injected via the `GET_SESSIONS`
 * token, wired by each app's composition root (#424).
 */
export function createStudyReminderProviders(
  options: CreateStudyReminderProvidersOptions,
): Provider[] {
  if (!options.canonicalPlatformService) {
    throw new Error(
      'createStudyReminderProviders requires canonicalPlatformService',
    );
  }
  // #777: per-platform advisory lock ids are mandatory — inheriting the
  // package defaults is exactly how all three bots ended up contending on
  // one sync lock id. Fail at boot, not at the first skipped sync.
  if (!options.workerLockIds) {
    throw new Error(
      'createStudyReminderProviders requires workerLockIds (per-platform advisory lock ids, see ADVISORY_LOCKS)',
    );
  }

  return [
    {
      provide: MESSAGE_SENDER,
      useFactory: (outbound: OutboundMessageSender) =>
        wrapMessageSender(outbound),
      inject: [options.outboundService],
    },
    options.mappingReader ?? {
      provide: MAPPING_READER,
      useFactory: (repo: Repository<AccountLinkRow>) =>
        new TypeormMappingReader(repo, options.mappingTable!),
      inject: [getRepositoryToken(options.mappingEntity!)],
    },
    {
      provide: STUDY_REMINDER_JOB_REPOSITORY,
      useExisting: TypeormStudyReminderJobRepository,
    },
    StudyReminderScheduleService,
    {
      provide: StudyReminderSyncService,
      useFactory: (
        mappingReader: MappingReaderPort,
        jobRepository: StudyReminderJobRepositoryPort,
        scheduleService: StudyReminderScheduleService,
        canonicalPlatformService: {
          getCanonicalPlatformForUser(
            userId: number,
          ): Promise<Platform | undefined>;
        },
      ) =>
        new StudyReminderSyncService(
          mappingReader,
          jobRepository,
          scheduleService,
          undefined,
          (userId) =>
            canonicalPlatformService.getCanonicalPlatformForUser(userId),
        ),
      inject: [
        MAPPING_READER,
        STUDY_REMINDER_JOB_REPOSITORY,
        StudyReminderScheduleService,
        options.canonicalPlatformService,
      ],
    },
    {
      // Constructed explicitly so the worker's platform is bound to every
      // due/claim/reset query (#180) — the class provider cannot inject it.
      provide: StudyReminderDispatchService,
      useFactory: (
        jobRepository: StudyReminderJobRepositoryPort,
        messageSender: MessageSenderPort,
        scheduleService: StudyReminderScheduleService,
        mappingReader: MappingReaderPort,
        dormancyGate?: { filterDormant(ids: number[]): Promise<number[]> },
        suppressionMetric?: {
          incScheduledSendSuppressed(
            f: 'reminder' | 'report',
            count?: number,
          ): void;
        },
      ) =>
        new StudyReminderDispatchService(
          jobRepository,
          messageSender,
          scheduleService,
          options.platform,
          suppressionMetric
            ? {
                onCancelled: (ctx) => {
                  if (ctx.reason === DORMANT_REASON) {
                    suppressionMetric.incScheduledSendSuppressed('reminder');
                  }
                },
              }
            : undefined,
          {
            getMappingState: async (externalUserId) => {
              if (mappingReader.getMappingState) {
                return mappingReader.getMappingState(
                  options.platform,
                  externalUserId,
                );
              }
              const link =
                await mappingReader.findActiveMappingByExternalUserId(
                  options.platform,
                  externalUserId,
                );
              return link ? 'active' : null;
            },
            filterDormantUserIds: dormancyGate
              ? (ids) => dormancyGate.filterDormant(ids)
              : undefined,
          },
        ),
      inject: [
        STUDY_REMINDER_JOB_REPOSITORY,
        MESSAGE_SENDER,
        StudyReminderScheduleService,
        MAPPING_READER,
        ...(options.dormancyGate
          ? [{ token: options.dormancyGate, optional: true }]
          : []),
        ...(options.dormancySuppressionMetric
          ? [{ token: options.dormancySuppressionMetric, optional: true }]
          : []),
      ],
    },
    {
      provide: StudyReminderWorkerService,
      useFactory: (
        syncService: StudyReminderSyncService,
        dispatchService: StudyReminderDispatchService,
        scheduleService: StudyReminderScheduleService,
        schedulerRegistry: SchedulerRegistry,
        pgLock: PgAdvisoryLockService,
        jobRepository: StudyReminderJobRepositoryPort | undefined,
        getSessions: GetSessionsFn,
        workerMetrics?: StudyReminderWorkerMetrics,
      ) =>
        createStudyReminderWorker(
          {
            syncService,
            dispatchService,
            scheduleService,
            schedulerRegistry,
            pgLock,
            jobRepository,
            getSessions,
          },
          {
            platform: options.platform,
            lockIds: options.workerLockIds,
            options:
              options.workerOptions || workerMetrics
                ? { ...options.workerOptions, metrics: workerMetrics }
                : undefined,
          },
        ),
      inject: [
        StudyReminderSyncService,
        StudyReminderDispatchService,
        StudyReminderScheduleService,
        { token: SchedulerRegistry, optional: false },
        PgAdvisoryLockService,
        { token: STUDY_REMINDER_JOB_REPOSITORY, optional: true },
        GET_SESSIONS,
        ...(options.workerMetrics
          ? [{ token: options.workerMetrics, optional: true }]
          : []),
      ],
    },
    TypeormStudyReminderJobRepository,
  ];
}
