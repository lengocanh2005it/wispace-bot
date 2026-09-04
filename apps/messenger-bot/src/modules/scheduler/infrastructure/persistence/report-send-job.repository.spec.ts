import { Repository } from 'typeorm';
import { ReportSendJobEntity } from '@wispace/database';
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
      query: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
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

  it('claims a job with a fresh lease token and expiry', async () => {
    const jobRepo = {
      query: jest.fn().mockResolvedValue([
        [
          {
            id: 7,
            platform: 'messenger',
            external_user_id: 'psid-1',
            user_id: null,
            exam_date: '2026-06-15',
            first_attempt_date: '2026-06-12',
            status: 'processing',
            retry_count: 1,
            max_retries: 3,
            next_retry_at: null,
            last_error: null,
            sent_at: null,
            lease_token: 'abc-lease',
            lease_expires_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        1,
      ]),
      createQueryBuilder: jest.fn(),
    } as unknown as Repository<ReportSendJobEntity>;
    const localRepo = new ReportSendJobRepository(jobRepo);

    const job = await localRepo.claimJob(7, 600_000);

    expect(job?.leaseToken).toBe('abc-lease');
    expect(job?.externalUserId).toBe('psid-1');
    const [sql, params] = (jobRepo.query as jest.Mock).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain('lease_token = gen_random_uuid()');
    expect(sql).toContain('lease_expires_at = now() + ($2::int');
    expect(params[1]).toBe(600_000);
  });

  it('returns null when the claim matches no row (real [[], 0] tuple shape)', async () => {
    const jobRepo = {
      query: jest.fn().mockResolvedValue([[], 0]),
      createQueryBuilder: jest.fn(),
    } as unknown as Repository<ReportSendJobEntity>;
    const localRepo = new ReportSendJobRepository(jobRepo);

    await expect(localRepo.claimJob(7, 600_000)).resolves.toBeNull();
  });

  it('markSent requires the lease token (stale owners no-op)', async () => {
    interface QbBuilder {
      update: jest.Mock;
      set: jest.Mock;
      where: jest.Mock;
      andWhere: jest.Mock;
      execute: jest.Mock;
    }
    const andWhere = jest.fn((_sql: string, params: unknown) => {
      capturedLease = params;
      return builder;
    });
    const builder: QbBuilder = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      andWhere,
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    builder.update.mockReturnValue(builder);
    builder.set.mockReturnValue(builder);
    builder.where.mockReturnValue(builder);
    const jobRepo = {
      createQueryBuilder: jest.fn(() => builder),
    } as unknown as Repository<ReportSendJobEntity>;
    let capturedLease: unknown;

    const localRepo = new ReportSendJobRepository(jobRepo);
    await localRepo.markSent(7, 'lease-abc');

    expect(capturedLease).toEqual({ leaseToken: 'lease-abc' });
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
      leaseToken: null,
      leaseExpiresAt: null,
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
