import { getRepositoryToken } from '@nestjs/typeorm';
import { createStudyReminderProviders } from './study-reminder-providers.factory';
import { MESSAGE_SENDER } from '../ports/message-sender.port';
import { MAPPING_READER } from '../ports/mapping-reader.port';
import { STUDY_REMINDER_JOB_REPOSITORY } from '../ports/study-reminder-job.repository.port';
import { StudyReminderScheduleService } from './study-reminder-schedule.service';
import { StudyReminderSyncService } from './study-reminder-sync.service';
import { StudyReminderDispatchService } from './study-reminder-dispatch.service';
import { StudyReminderWorkerService } from './study-reminder-worker.service';
import { TypeormStudyReminderJobRepository } from '../infrastructure/typeorm-study-reminder-job.repository';

class FakeOutbound {
  sendText(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeMappingEntity {}

class FakeCalendarService {
  getCalendarSessions(): Promise<unknown[]> {
    return Promise.resolve([]);
  }
}

describe('createStudyReminderProviders', () => {
  const providers = createStudyReminderProviders({
    platform: 'discord',
    mappingTable: 'discord_account_links',
    mappingEntity: FakeMappingEntity,
    outboundService: FakeOutbound,
    calendarService: FakeCalendarService,
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
    expect(providers[5]).toBe(StudyReminderDispatchService);
    expect(p[6]).toMatchObject({
      provide: StudyReminderWorkerService,
      inject: [
        StudyReminderSyncService,
        StudyReminderDispatchService,
        StudyReminderScheduleService,
        {},
        {},
        { token: STUDY_REMINDER_JOB_REPOSITORY, optional: true },
        FakeCalendarService,
      ],
    });
    expect(providers[7]).toBe(TypeormStudyReminderJobRepository);
  });

  it('builds a StudyReminderWorkerService from the worker factory', () => {
    const worker = providers[6] as unknown as {
      useFactory: (...deps: unknown[]) => unknown;
    };
    const service = worker.useFactory(
      {},
      {},
      {},
      {},
      {},
      {},
      new FakeCalendarService(),
    );
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
      getSessionsService: FakeCalendarService,
    });

    expect(withReader[1]).toBe(customReader);
  });

  it('builds the worker from getSessionsService + worker lock ids when provided (messenger)', () => {
    const lockIds = { sync: 1, cleanup: 2, rollover: 3 };
    const withReader = createStudyReminderProviders({
      platform: 'messenger',
      outboundService: FakeOutbound,
      mappingReader: { provide: MAPPING_READER, useValue: {} },
      getSessionsService: FakeCalendarService,
      workerLockIds: lockIds,
      workerOptions: { logLockSkips: true, startupSyncSwallowErrors: true },
    });

    const workerProvider = withReader[6] as unknown as {
      useFactory: (...deps: unknown[]) => unknown;
      inject: unknown[];
    };
    expect(workerProvider.inject[6]).toBe(FakeCalendarService);

    const service = workerProvider.useFactory(
      {},
      {},
      {},
      {},
      {},
      {},
      new FakeCalendarService(),
    );
    expect(service).toBeInstanceOf(StudyReminderWorkerService);
  });
});
