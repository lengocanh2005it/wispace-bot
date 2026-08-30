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

const fakeGetSessions: GetSessionsFn = () => Promise.resolve([]);

describe('createStudyReminderProviders', () => {
  const providers = createStudyReminderProviders({
    platform: 'discord',
    mappingTable: 'discord_account_links',
    mappingEntity: FakeMappingEntity,
    outboundService: FakeOutbound,
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
    expect(providers[4]).toBe(StudyReminderSyncService);
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
});
