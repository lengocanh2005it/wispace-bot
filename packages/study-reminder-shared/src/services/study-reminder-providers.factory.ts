import type { Provider } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import type { WispaceCalendarService } from '@wispace/wispace-client';
import type { Repository } from 'typeorm';
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
import { StudyReminderDispatchService } from './study-reminder-dispatch.service';
import { StudyReminderWorkerService } from './study-reminder-worker.service';
import { TypeormStudyReminderJobRepository } from '../infrastructure/typeorm-study-reminder-job.repository';
import type { GetSessionsFn } from '../types/study-reminder.types';
import type { Platform } from '@wispace/database';
import type {
  StudyReminderWorkerLockIds,
  StudyReminderWorkerOptions,
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
  /** Required when `getSessionsService` is not provided (discord/zalo). */
  calendarService?: ClassOf<WispaceCalendarService>;
  /** Messenger: replaces the TypeormMappingReader factory with a custom provider (backed by MESSENGER_REPOSITORY). */
  mappingReader?: Provider;
  /**
   * Messenger: worker getSessions source. When set, the worker factory
   * injects this provider and calls `getUpcomingSessions({ psid, userId })`
   * instead of the calendar mapping.
   */
  getSessionsService?: ClassOf<GetUpcomingSessionsService>;
  /** Messenger: advisory lock ids for sync/cleanup/rollover (shared defaults when absent). */
  workerLockIds?: StudyReminderWorkerLockIds;
  /** Messenger: worker options (logLockSkips, startupSyncSwallowErrors). */
  workerOptions?: StudyReminderWorkerOptions;
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
 * Builds the authoritative `getSessions` provider from a Wispace calendar
 * service (upcoming sessions) — used by the shared worker and by direct
 * sync entry points (Discord/Zalo ops controllers) so a sync is never
 * executed against an assumed-empty calendar.
 */
export function createCalendarGetSessions(
  service: WispaceCalendarService,
): GetSessionsFn {
  return (externalUserId: string) =>
    service
      .getCalendarSessions(externalUserId, { timeRange: 'upcoming' })
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
 * modules. Parameterized by platform, mapping table/entity, outbound service
 * and the Wispace calendar service (injected as the worker's `getSessions`).
 */
export function createStudyReminderProviders(
  options: CreateStudyReminderProvidersOptions,
): Provider[] {
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
    StudyReminderSyncService,
    {
      // Constructed explicitly so the worker's platform is bound to every
      // due/claim/reset query (#180) — the class provider cannot inject it.
      provide: StudyReminderDispatchService,
      useFactory: (
        jobRepository: StudyReminderJobRepositoryPort,
        messageSender: MessageSenderPort,
        scheduleService: StudyReminderScheduleService,
        mappingReader: MappingReaderPort,
      ) =>
        new StudyReminderDispatchService(
          jobRepository,
          messageSender,
          scheduleService,
          options.platform,
          undefined,
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
          },
        ),
      inject: [
        STUDY_REMINDER_JOB_REPOSITORY,
        MESSAGE_SENDER,
        StudyReminderScheduleService,
        MAPPING_READER,
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
        sessionSource: WispaceCalendarService | GetUpcomingSessionsService,
      ) =>
        createStudyReminderWorker(
          {
            syncService,
            dispatchService,
            scheduleService,
            schedulerRegistry,
            pgLock,
            jobRepository,
            getSessions: options.getSessionsService
              ? createSessionSourceGetSessions(
                  sessionSource as GetUpcomingSessionsService,
                )
              : createCalendarGetSessions(
                  sessionSource as WispaceCalendarService,
                ),
          },
          {
            platform: options.platform,
            lockIds: options.workerLockIds,
            options: options.workerOptions,
          },
        ),
      inject: [
        StudyReminderSyncService,
        StudyReminderDispatchService,
        StudyReminderScheduleService,
        { token: SchedulerRegistry, optional: false },
        PgAdvisoryLockService,
        { token: STUDY_REMINDER_JOB_REPOSITORY, optional: true },
        options.getSessionsService ?? options.calendarService!,
      ],
    },
    TypeormStudyReminderJobRepository,
  ];
}
