import { Repository } from 'typeorm';
import { StudyReminderJobEntity } from '../../../../infrastructure/database/entities/study-reminder-job.entity';
import { UpsertStudyReminderJobInput } from '../../domain/entities/study-reminder-job.types';
import { StudyReminderJobRepository } from './study-reminder-job.repository';

describe('StudyReminderJobRepository', () => {
  let repository: StudyReminderJobRepository;
  let store: Map<string, StudyReminderJobEntity>;
  let nextId: number;

  const baseInput = (
    overrides: Partial<UpsertStudyReminderJobInput> = {},
  ): UpsertStudyReminderJobInput => ({
    platform: 'messenger',
    psid: 'psid-1',
    userId: 143,
    sessionKey: 'calendar:5',
    scheduledAt: new Date('2026-06-12T10:30:00+07:00'),
    remindAt: new Date('2026-06-12T10:00:00+07:00'),
    topic: 'IELTS Writing',
    maxRetries: 3,
    ...overrides,
  });

  const seedJob = (
    overrides: Partial<StudyReminderJobEntity> = {},
  ): StudyReminderJobEntity => {
    const input = baseInput();
    const job: StudyReminderJobEntity = {
      id: nextId++,
      platform: 'messenger',
      externalUserId: input.psid,
      userId: input.userId ?? null,
      sessionKey: input.sessionKey,
      scheduledAt: input.scheduledAt,
      remindAt: input.remindAt,
      topic: input.topic ?? null,
      status: 'pending',
      retryCount: 0,
      maxRetries: input.maxRetries,
      nextRetryAt: null,
      lastError: null,
      sentAt: null,
      createdAt: new Date('2026-06-10T08:00:00+07:00'),
      updatedAt: new Date('2026-06-10T08:00:00+07:00'),
      ...overrides,
    };

    store.set(`${job.externalUserId}:${job.sessionKey}`, job);
    return job;
  };

  beforeEach(() => {
    store = new Map();
    nextId = 1;

    const transactionManager = {
      query: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(
        (
          _entity: typeof StudyReminderJobEntity,
          { where }: { where: Record<string, string> },
        ) =>
          Promise.resolve(
            store.get(`${where.externalUserId}:${where.sessionKey}`) ?? null,
          ),
      ),
      create: jest.fn(
        (
          _entity: typeof StudyReminderJobEntity,
          data: Partial<StudyReminderJobEntity>,
        ) =>
          ({
            id: nextId++,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          }) as StudyReminderJobEntity,
      ),
      save: jest.fn(
        (
          _entity: typeof StudyReminderJobEntity,
          entity: StudyReminderJobEntity,
        ) => {
          const saved = { ...entity, updatedAt: new Date() };
          store.set(`${saved.externalUserId}:${saved.sessionKey}`, saved);
          return Promise.resolve(saved);
        },
      ),
    };

    const jobRepo = {
      manager: {
        transaction: jest.fn(
          async <T>(
            callback: (manager: typeof transactionManager) => Promise<T>,
          ) => callback(transactionManager),
        ),
      },
    } as unknown as Repository<StudyReminderJobEntity>;

    repository = new StudyReminderJobRepository(jobRepo);
  });

  it('creates a pending job when none exists', async () => {
    const result = await repository.upsertPendingJob(baseInput());

    expect(result.status).toBe('pending');
    expect(result.sessionKey).toBe('calendar:5');
  });

  it('keeps sent job when schedule is unchanged', async () => {
    seedJob({
      status: 'sent',
      sentAt: new Date('2026-06-12T10:00:00+07:00'),
    });

    const result = await repository.upsertPendingJob(baseInput());

    expect(result.status).toBe('sent');
    expect(result.sentAt).toBeDefined();
  });

  it('reopens sent job to pending when scheduled time changes', async () => {
    seedJob({
      status: 'sent',
      sentAt: new Date('2026-06-12T10:00:00+07:00'),
    });

    const result = await repository.upsertPendingJob(
      baseInput({
        scheduledAt: new Date('2026-06-12T14:30:00+07:00'),
        remindAt: new Date('2026-06-12T14:00:00+07:00'),
      }),
    );

    expect(result.status).toBe('pending');
    expect(result.sentAt).toBeUndefined();
    expect(result.scheduledAt.toISOString()).toBe(
      new Date('2026-06-12T14:30:00+07:00').toISOString(),
    );
    expect(result.retryCount).toBe(0);
  });

  it('reopens cancelled job when session returns in sync', async () => {
    seedJob({
      status: 'cancelled',
      lastError: 'stale session',
    });

    const result = await repository.upsertPendingJob(baseInput());

    expect(result.status).toBe('pending');
    expect(result.lastError).toBeUndefined();
    expect(result.retryCount).toBe(0);
  });

  it('reopens cancelled job with updated schedule', async () => {
    seedJob({ status: 'cancelled' });

    const result = await repository.upsertPendingJob(
      baseInput({
        scheduledAt: new Date('2026-06-12T16:00:00+07:00'),
        remindAt: new Date('2026-06-12T15:30:00+07:00'),
      }),
    );

    expect(result.status).toBe('pending');
    expect(result.scheduledAt.toISOString()).toBe(
      new Date('2026-06-12T16:00:00+07:00').toISOString(),
    );
  });

  it('leaves processing job alone when schedule is unchanged', async () => {
    seedJob({ status: 'processing' });

    const result = await repository.upsertPendingJob(baseInput());

    expect(result.status).toBe('processing');
  });

  it('reopens processing job to pending when schedule changes', async () => {
    seedJob({ status: 'processing' });

    const result = await repository.upsertPendingJob(
      baseInput({
        scheduledAt: new Date('2026-06-12T16:00:00+07:00'),
        remindAt: new Date('2026-06-12T15:30:00+07:00'),
      }),
    );

    expect(result.status).toBe('pending');
    expect(result.retryCount).toBe(0);
  });

  it('updates pending job schedule in place', async () => {
    seedJob({ status: 'pending' });

    const result = await repository.upsertPendingJob(
      baseInput({
        scheduledAt: new Date('2026-06-12T11:00:00+07:00'),
        remindAt: new Date('2026-06-12T10:30:00+07:00'),
      }),
    );

    expect(result.status).toBe('pending');
    expect(result.scheduledAt.toISOString()).toBe(
      new Date('2026-06-12T11:00:00+07:00').toISOString(),
    );
  });
});
