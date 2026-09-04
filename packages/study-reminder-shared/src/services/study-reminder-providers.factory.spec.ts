import { getRepositoryToken } from '@nestjs/typeorm';
import { createStudyReminderProviders } from './study-reminder-providers.factory';
import { MESSAGE_SENDER } from '../ports/message-sender.port';
import { MAPPING_READER } from '../ports/mapping-reader.port';
import { STUDY_REMINDER_JOB_REPOSITORY } from '../ports/study-reminder-job.repository.port';
import { GET_SESSIONS } from '../ports/get-sessions.port';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
import { StudyReminderSyncService } from './study-reminder-sync.service';
import { StudyReminderDispatchService } from './study-reminder-dispatch.service';
import { StudyReminderWorkerService } from './study-reminder-worker.service';
import { TypeormStudyReminderJobRepository } from '../infrastructure/typeorm-study-reminder-job.repository';
import type { GetSessionsFn } from '../types/study-reminder.types';

class FakeOutbound {
  sendText(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeMappingEntity {}

class FakeCanonicalPlatformService {
  getCanonicalPlatformForUser(): Promise<'discord'> {
    return Promise.resolve('discord');
  }
}

const fakeGetSessions: GetSessionsFn = () => Promise.resolve([]);

const DEFAULT_LOCK_IDS = {
  sync: 884_200_944,
  cleanup: 884_200_945,
  rollover: 884_200_946,
};

describe('createStudyReminderProviders', () => {
  const providers = createStudyReminderProviders({
    platform: 'discord',
    mappingTable: 'discord_account_links',
    mappingEntity: FakeMappingEntity,
    outboundService: FakeOutbound,
    canonicalPlatformService: FakeCanonicalPlatformService,
    workerLockIds: DEFAULT_LOCK_IDS,
  });
  const p = providers as unknown as Array<{
    provide?: unknown;
    useExisting?: unknown;
    inject?: unknown[];
  }>;

  it('returns the 8 providers in order with expected token keys', () => {
    expect(providers).toHaveLength(8);
    expect(p[0]).toMatchObject({
      provide: MESSAGE_SENDER,
      inject: [FakeOutbound],
    });
    expect(p[1]).toMatchObject({
      provide: MAPPING_READER,
      inject: [getRepositoryToken(FakeMappingEntity)],
    });
    expect(p[2]).toMatchObject({
      provide: STUDY_REMINDER_JOB_REPOSITORY,
      useExisting: TypeormStudyReminderJobRepository,
    });
    expect(providers[3]).toBe(StudyReminderScheduleService);
    expect(p[4]).toMatchObject({
      provide: StudyReminderSyncService,
      inject: [
        MAPPING_READER,
        STUDY_REMINDER_JOB_REPOSITORY,
        StudyReminderScheduleService,
        FakeCanonicalPlatformService,
      ],
    });
    expect(p[5]).toMatchObject({
      provide: StudyReminderDispatchService,
      inject: [
        STUDY_REMINDER_JOB_REPOSITORY,
        MESSAGE_SENDER,
        StudyReminderScheduleService,
        MAPPING_READER,
      ],
    });
    expect(p[6]).toMatchObject({
      provide: StudyReminderWorkerService,
      inject: [
        StudyReminderSyncService,
        StudyReminderDispatchService,
        StudyReminderScheduleService,
        {},
        {},
        { token: STUDY_REMINDER_JOB_REPOSITORY, optional: true },
        GET_SESSIONS,
      ],
    });
    expect(providers[7]).toBe(TypeormStudyReminderJobRepository);
  });

  it('builds a StudyReminderWorkerService from the worker factory', () => {
    const worker = providers[6] as unknown as {
      useFactory: (...deps: unknown[]) => unknown;
    };
    const service = worker.useFactory({}, {}, {}, {}, {}, {}, fakeGetSessions);
    expect(service).toBeInstanceOf(StudyReminderWorkerService);
  });

  it('builds a message sender and mapping reader from their factories', () => {
    const sender = providers[0] as unknown as {
      useFactory: (outbound: unknown) => unknown;
    };
    expect(sender.useFactory(new FakeOutbound())).toBeDefined();

    const reader = providers[1] as unknown as {
      useFactory: (repo: unknown) => unknown;
    };
    expect(
      reader.useFactory({
        query: () => Promise.resolve([]),
        findOne: () => Promise.resolve(null),
      }),
    ).toBeDefined();
  });

  it('uses the provided mappingReader provider instead of the TypeormMappingReader factory', () => {
    const customReader = { provide: MAPPING_READER, useValue: {} };
    const withReader = createStudyReminderProviders({
      platform: 'messenger',
      outboundService: FakeOutbound,
      mappingReader: customReader,
      workerLockIds: {
        sync: 884_200_901,
        cleanup: 884_200_902,
        rollover: 884_200_903,
      },
      canonicalPlatformService: FakeCanonicalPlatformService,
    });

    expect(withReader[1]).toBe(customReader);
  });

  it('requires the GET_SESSIONS token (fail-closed) and passes it straight to the worker factory', () => {
    const lockIds = { sync: 1, cleanup: 2, rollover: 3 };
    const withReader = createStudyReminderProviders({
      platform: 'messenger',
      outboundService: FakeOutbound,
      mappingReader: { provide: MAPPING_READER, useValue: {} },
      workerLockIds: lockIds,
      workerOptions: { logLockSkips: true, startupSyncSwallowErrors: true },
      canonicalPlatformService: FakeCanonicalPlatformService,
    });

    const workerProvider = withReader[6] as unknown as {
      useFactory: (...deps: unknown[]) => unknown;
      inject: unknown[];
    };
    // Required, non-optional injection: a missing provider fails startup.
    expect(workerProvider.inject[6]).toBe(GET_SESSIONS);

    const service = workerProvider.useFactory(
      {},
      {},
      {},
      {},
      {},
      {},
      fakeGetSessions,
    );
    expect(service).toBeInstanceOf(StudyReminderWorkerService);
  });

  it('includes dormancy tokens in StudyReminderDispatchService inject when provided', () => {
    class FakeGate {
      filterDormant() {
        return Promise.resolve([]);
      }
    }
    class FakeMetric {
      incScheduledSendSuppressed() {}
    }
    const withGate = createStudyReminderProviders({
      platform: 'discord',
      mappingTable: 'discord_account_links',
      mappingEntity: FakeMappingEntity,
      outboundService: FakeOutbound,
      dormancyGate: FakeGate,
      dormancySuppressionMetric: FakeMetric,
      canonicalPlatformService: FakeCanonicalPlatformService,
      workerLockIds: DEFAULT_LOCK_IDS,
    });
    const dispatchProvider = withGate[5] as unknown as {
      inject: unknown[];
    };
    expect(dispatchProvider.inject).toContainEqual({
      token: FakeGate,
      optional: true,
    });
    expect(dispatchProvider.inject).toContainEqual({
      token: FakeMetric,
      optional: true,
    });
  });

  it('builds the sync service with the canonical resolver from the factory', async () => {
    const syncProvider = p[4] as unknown as {
      useFactory: (...deps: unknown[]) => StudyReminderSyncService;
    };
    const jobRepository = {
      upsertPendingJobs: jest.fn().mockResolvedValue([]),
      cancelStaleJobsForExternalUserId: jest.fn().mockResolvedValue(1),
    };
    const mappingReader = {
      findActiveMappingsPage: jest.fn().mockResolvedValue({
        items: [
          { externalUserId: 'discord-user', userId: 42, platform: 'discord' },
        ],
        nextId: undefined,
      }),
      findActiveMappingByExternalUserId: jest.fn(),
    };
    const scheduleService = {
      getOutboxSettings: jest.fn().mockReturnValue({
        maxRetries: 3,
        syncHorizonHours: 168,
      }),
      computeRemindAt: jest.fn((date: Date) => date),
    };
    const canonicalPlatformService = {
      getCanonicalPlatformForUser: jest.fn().mockResolvedValue('zalo'),
    };
    const syncService = syncProvider.useFactory(
      mappingReader,
      jobRepository,
      scheduleService,
      canonicalPlatformService,
    );

    const result = await syncService.syncUpcomingSessions({
      platform: 'discord',
      getSessions: jest.fn().mockResolvedValue([
        {
          calendarId: 'session-1',
          sessionKey: 'session-1',
          scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      ]),
    });

    expect(
      canonicalPlatformService.getCanonicalPlatformForUser,
    ).toHaveBeenCalledWith(42);
    expect(jobRepository.upsertPendingJobs).not.toHaveBeenCalled();
    expect(jobRepository.cancelStaleJobsForExternalUserId).toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1, upserted: 0, cancelled: 1 });
  });

  it('rejects factory construction when the canonical service is missing', () => {
    expect(() =>
      createStudyReminderProviders({
        platform: 'discord',
        mappingTable: 'discord_account_links',
        mappingEntity: FakeMappingEntity,
        outboundService: FakeOutbound,
      } as never),
    ).toThrow('canonicalPlatformService');
  });

  it('rejects factory construction without explicit worker lock ids (fail-closed, #777)', () => {
    expect(() =>
      createStudyReminderProviders({
        platform: 'discord',
        mappingTable: 'discord_account_links',
        mappingEntity: FakeMappingEntity,
        outboundService: FakeOutbound,
        canonicalPlatformService: FakeCanonicalPlatformService,
      } as never),
    ).toThrow('workerLockIds');
  });
});
