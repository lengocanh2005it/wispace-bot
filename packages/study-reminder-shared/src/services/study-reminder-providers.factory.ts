import type { Provider } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PgAdvisoryLockService } from '@wispace/bot-common';
import type { WispaceCalendarService } from '@wispace/wispace-client';
import type { Repository } from 'typeorm';
import { MESSAGE_SENDER } from '../ports/message-sender.port';
import { MAPPING_READER } from '../ports/mapping-reader.port';
import { STUDY_REMINDER_JOB_REPOSITORY } from '../ports/study-reminder-job.repository.port';
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
import type {
  GetSessionsFn,
  StudySessionRecord,
} from '../types/study-reminder.types';
import type {
  StudyReminderWorkerLockIds,
  StudyReminderWorkerOptions,
} from './study-reminder-worker.service';

export type StudyReminderProviderTarget = new (...args: never[]) => unknown;

export interface CreateStudyReminderProvidersOptions {
  platform: string;
  /** Required when `mappingReader` is not provided (discord/zalo). */
  mappingTable?: string;
  /** Required when `mappingReader` is not provided (discord/zalo). */
  mappingEntity?: StudyReminderProviderTarget;
  outboundService: StudyReminderProviderTarget;
  /** Required when `getSessionsService` is not provided (discord/zalo). */
  calendarService?: StudyReminderProviderTarget;
  /** Messenger: replaces the TypeormMappingReader factory with a custom provider (backed by MESSENGER_REPOSITORY). */
  mappingReader?: Provider;
  /**
   * Messenger: worker getSessions source. When set, the worker factory
   * injects this provider (deps[6]) and calls
   * `getUpcomingSessions({ psid, userId })` instead of the calendar mapping.
   */
  getSessionsService?: StudyReminderProviderTarget;
  /** Messenger: advisory lock ids for sync/cleanup/rollover (shared defaults when absent). */
  workerLockIds?: StudyReminderWorkerLockIds;
  /** Messenger: worker options (logLockSkips, startupSyncSwallowErrors). */
  workerOptions?: StudyReminderWorkerOptions;
}

/** Structural surface of messenger's StudySessionSourceService (no cross-app import). */
interface GetUpcomingSessionsService {
  getUpcomingSessions(input: {
    psid: string;
    userId?: number;
  }): Promise<StudySessionRecord[]>;
}

function buildCalendarGetSessions(service: unknown): GetSessionsFn | undefined {
  if (!service) return undefined;
  return (externalUserId: string) =>
    (service as WispaceCalendarService)
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

function buildSessionSourceGetSessions(
  service: unknown,
): GetSessionsFn | undefined {
  if (!service) return undefined;
  return (externalUserId: string, userId?: number) =>
    (service as GetUpcomingSessionsService).getUpcomingSessions({
      psid: externalUserId,
      userId,
    });
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
    StudyReminderDispatchService,
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
          options.platform,
          options.getSessionsService
            ? buildSessionSourceGetSessions(deps[6])
            : buildCalendarGetSessions(deps[6]),
          options.workerLockIds,
          options.workerOptions,
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
