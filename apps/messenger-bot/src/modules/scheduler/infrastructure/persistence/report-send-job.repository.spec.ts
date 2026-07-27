import { Repository } from 'typeorm';
import { ReportSendJobEntity } from '../../../../infrastructure/database/entities/report-send-job.entity';
import { ReportSendJobRepository } from './report-send-job.repository';

describe('ReportSendJobRepository (R5)', () => {
  let repository: ReportSendJobRepository;
  let store: Map<string, ReportSendJobEntity>;
  let nextId: number;

  const key = (psid: string, examDate: string) => `${psid}:${examDate}`;

  beforeEach(() => {
    store = new Map();
    nextId = 1;

    const jobRepo = {
      findOne: jest.fn(({ where }: { where: Record<string, string> }) =>
        Promise.resolve(
          store.get(key(where.externalUserId, where.examDate)) ?? null,
        ),
      ),
      create: jest.fn(
        (data: Partial<ReportSendJobEntity>) =>
          ({
            id: nextId++,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          }) as ReportSendJobEntity,
      ),
      save: jest.fn((entity: ReportSendJobEntity) => {
        const saved = { ...entity, updatedAt: new Date() };
        store.set(key(saved.externalUserId, saved.examDate), saved);
        return Promise.resolve(saved);
      }),
      update: jest.fn(
        (
          criteria: number | Record<string, unknown>,
          patch: Partial<ReportSendJobEntity>,
        ) => {
          if (typeof criteria === 'number') {
            const row = [...store.values()].find((j) => j.id === criteria);
            if (row) {
              Object.assign(row, patch, { updatedAt: new Date() });
              return Promise.resolve({ affected: 1 });
            }
            return Promise.resolve({ affected: 0 });
          }
          return Promise.resolve({ affected: 0 });
        },
      ),
    } as unknown as Repository<ReportSendJobEntity>;

    repository = new ReportSendJobRepository(jobRepo);
  });

  it('creates retry job on first Wispace 5xx failure', async () => {
    const nextRetryAt = new Date('2026-06-12T08:15:00+07:00');

    const job = await repository.recordRetryableFailure({
      psid: 'psid-1',
      userId: 10,
      examDate: '2026-06-15',
      firstAttemptDate: '2026-06-12',
      maxRetries: 3,
      nextRetryAt,
      errorMessage: '503 Service Unavailable',
    });

    expect(job.retryCount).toBe(1);
    expect(job.nextRetryAt).toEqual(nextRetryAt);
    expect(job.status).toBe('failed');
  });

  it('increments retry_count on repeated cron failures', async () => {
    const nextRetryAt = new Date('2026-06-12T08:15:00+07:00');

    await repository.recordRetryableFailure({
      psid: 'psid-1',
      examDate: '2026-06-15',
      firstAttemptDate: '2026-06-12',
      maxRetries: 3,
      nextRetryAt,
      errorMessage: '503',
    });

    const second = await repository.recordRetryableFailure({
      psid: 'psid-1',
      examDate: '2026-06-15',
      firstAttemptDate: '2026-06-12',
      maxRetries: 3,
      nextRetryAt,
      errorMessage: '503 again',
    });

    expect(second.retryCount).toBe(2);
    expect(second.nextRetryAt).toEqual(nextRetryAt);
  });

  it('marks terminal when retry_count reaches max_retries', async () => {
    store.set(key('psid-1', '2026-06-15'), {
      id: 1,
      platform: 'messenger',
      externalUserId: 'psid-1',
      userId: null,
      examDate: '2026-06-15',
      firstAttemptDate: '2026-06-12',
      status: 'failed',
      retryCount: 2,
      maxRetries: 3,
      nextRetryAt: new Date('2026-06-12T08:00:00+07:00'),
      lastError: 'old',
      sentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const job = await repository.recordRetryableFailure({
      externalUserId: 'psid-1',
      examDate: '2026-06-15',
      firstAttemptDate: '2026-06-12',
      maxRetries: 3,
      nextRetryAt: new Date('2026-06-12T08:30:00+07:00'),
      errorMessage: '503 final',
    });

    expect(job.retryCount).toBe(3);
    expect(job.nextRetryAt).toBeUndefined();
  });
});
