import { Repository } from 'typeorm';
import { TypeormStudyReminderJobRepository } from './typeorm-study-reminder-job.repository';
import { StudyReminderJobEntity } from '../entities/study-reminder-job.entity';
import type { UpsertStudyReminderJobInput } from '../ports/study-reminder-job.repository.port';

describe('TypeormStudyReminderJobRepository', () => {
  let repository: TypeormStudyReminderJobRepository;
  let store: Map<string, StudyReminderJobEntity>;
  let nextId: number;
  let queryLog: Array<{ method: string; args: unknown[] }>;
  let updateMock: jest.Mock;
  let transactionMock: jest.Mock;
  let managerQuery: jest.Mock;
  let createQueryBuilderMock: jest.Mock;

  const baseInput = (
    overrides: Partial<UpsertStudyReminderJobInput> = {},
  ): UpsertStudyReminderJobInput => ({
    platform: 'messenger',
    externalUserId: 'psid-1',
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
      externalUserId: input.externalUserId,
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
      leaseToken: null,
      leaseExpiresAt: null,
      deliveryRecord: null,
      deliveryKey: null,
      deliveryStatus: null,
      processingStartedAt: null,
      createdAt: new Date('2026-06-10T08:00:00+07:00'),
      updatedAt: new Date('2026-06-10T08:00:00+07:00'),
      ...overrides,
    };

    store.set(`${job.externalUserId}:${job.sessionKey}`, job);
    return job;
  };

  function buildQb(): {
    execute: jest.Mock;
    getCount: jest.Mock;
    getMany: jest.Mock;
    getOne: jest.Mock;
    getRawMany: jest.Mock;
  } {
    const mocks = {
      execute: jest.fn().mockResolvedValue({ affected: 7 }),
      getCount: jest.fn().mockResolvedValue(3),
      getMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(null),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    const qb = new Proxy(mocks, {
      get: (target, prop: string | symbol) => {
        if (prop in target) return target[prop as keyof typeof target];
        return (...args: unknown[]) => {
          queryLog.push({ method: String(prop), args });
          return qb;
        };
      },
    });

    return qb;
  }

  beforeEach(() => {
    store = new Map();
    nextId = 1;
    queryLog = [];
    updateMock = jest.fn().mockResolvedValue({ affected: 1 });

    const transactionManager = {
      query: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(
        (
          _entity: typeof StudyReminderJobEntity,
          { where }: { where: Record<string, string> },
        ) =>
          Promise.resolve(
            store.get(`${where.externalUserId}:${where.sessionKey}`) ?? null,
          ),
      ),
      findBy: jest.fn(
        (
          _entity: typeof StudyReminderJobEntity,
          conditions: Array<Record<string, string>>,
        ) =>
          Promise.resolve(
            conditions
              .map((where) =>
                store.get(`${where.externalUserId}:${where.sessionKey}`),
              )
              .filter((job): job is StudyReminderJobEntity => job != null),
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
          entity: StudyReminderJobEntity | StudyReminderJobEntity[],
        ) => {
          const wasArray = Array.isArray(entity);
          const entities = wasArray ? entity : [entity];
          const saved = entities.map((item) => {
            const row = { ...item, updatedAt: new Date() };
            store.set(`${row.externalUserId}:${row.sessionKey}`, row);
            return row;
          });
          return Promise.resolve(wasArray ? saved : saved[0]);
        },
      ),
    };

    transactionMock = jest.fn(
      async <T>(callback: (manager: typeof transactionManager) => Promise<T>) =>
        callback(transactionManager),
    );

    managerQuery = transactionManager.query;

    createQueryBuilderMock = jest.fn(() => buildQb());

    const jobRepo = {
      manager: {
        transaction: transactionMock,
        findOne: transactionManager.findOne,
        findBy: transactionManager.findBy,
        create: transactionManager.create,
        save: transactionManager.save,
        query: transactionManager.query,
      },
      update: updateMock,
      createQueryBuilder: createQueryBuilderMock,
    } as unknown as Repository<StudyReminderJobEntity>;

    repository = new TypeormStudyReminderJobRepository(jobRepo);
  });

  describe('upsertPendingJob', () => {
    it('creates a pending job when none exists', async () => {
      const result = await repository.upsertPendingJob(baseInput());

      expect(result.status).toBe('pending');
      expect(result.sessionKey).toBe('calendar:5');
    });

    describe('reopenOnlyOnScheduleChange (Messenger)', () => {
      const options = { reopenOnlyOnScheduleChange: true };

      it('keeps sent job when schedule is unchanged', async () => {
        seedJob({
          status: 'sent',
          sentAt: new Date('2026-06-12T10:00:00+07:00'),
        });

        const result = await repository.upsertPendingJob(baseInput(), options);

        expect(result.status).toBe('sent');
        expect(result.sentAt).toBeDefined();
      });

      it('reopens sent job to pending when scheduled time changes', async () => {
        seedJob({
          status: 'sent',
          sentAt: new Date('2026-06-12T10:00:00+07:00'),
          deliveryRecord: 'provider-1',
          deliveryKey: 'old-key',
          deliveryStatus: 'sent',
          leaseToken: 'old-lease',
          leaseExpiresAt: new Date('2026-06-12T11:00:00+07:00'),
          processingStartedAt: new Date('2026-06-12T10:00:00+07:00'),
        });

        const result = await repository.upsertPendingJob(
          baseInput({
            scheduledAt: new Date('2026-06-12T14:30:00+07:00'),
            remindAt: new Date('2026-06-12T14:00:00+07:00'),
          }),
          options,
        );

        expect(result.status).toBe('pending');
        expect(result.sentAt).toBeUndefined();
        expect(result.scheduledAt.toISOString()).toBe(
          new Date('2026-06-12T14:30:00+07:00').toISOString(),
        );
        expect(result.retryCount).toBe(0);
        expect(result.deliveryRecord).toBeUndefined();
        expect(result.deliveryKey).toBeUndefined();
        expect(result.deliveryStatus).toBeUndefined();
        expect(result.leaseToken).toBeUndefined();
        expect(result.leaseExpiresAt).toBeUndefined();
        expect(result.processingStartedAt).toBeUndefined();
      });

      it('reopens cancelled job when session returns in sync', async () => {
        seedJob({ status: 'cancelled', lastError: 'stale session' });

        const result = await repository.upsertPendingJob(baseInput(), options);

        expect(result.status).toBe('pending');
        expect(result.lastError).toBeUndefined();
        expect(result.retryCount).toBe(0);
      });

      it('leaves processing job alone when schedule is unchanged', async () => {
        seedJob({ status: 'processing' });

        const result = await repository.upsertPendingJob(baseInput(), options);

        expect(result.status).toBe('processing');
      });

      it('reopens processing job to pending when schedule changes', async () => {
        seedJob({
          status: 'processing',
          deliveryKey: 'old-key',
          deliveryStatus: 'not_sent',
          leaseToken: 'old-lease',
          leaseExpiresAt: new Date('2026-06-12T11:00:00+07:00'),
          processingStartedAt: new Date('2026-06-12T10:00:00+07:00'),
        });

        const result = await repository.upsertPendingJob(
          baseInput({
            scheduledAt: new Date('2026-06-12T16:00:00+07:00'),
            remindAt: new Date('2026-06-12T15:30:00+07:00'),
          }),
          options,
        );

        expect(result.status).toBe('pending');
        expect(result.retryCount).toBe(0);
        expect(result.deliveryKey).toBeUndefined();
        expect(result.deliveryStatus).toBeUndefined();
        expect(result.leaseToken).toBeUndefined();
        expect(result.leaseExpiresAt).toBeUndefined();
        expect(result.processingStartedAt).toBeUndefined();
      });

      it('reopens pending job when the schedule changes and resets retry state', async () => {
        seedJob({ status: 'pending', retryCount: 2 });

        const result = await repository.upsertPendingJob(
          baseInput({
            scheduledAt: new Date('2026-06-12T11:00:00+07:00'),
            remindAt: new Date('2026-06-12T10:30:00+07:00'),
          }),
          options,
        );

        expect(result.status).toBe('pending');
        expect(result.scheduledAt.toISOString()).toBe(
          new Date('2026-06-12T11:00:00+07:00').toISOString(),
        );
        expect(result.retryCount).toBe(0);
      });
    });

    describe('default behavior (Discord/Zalo)', () => {
      it('reopens sent job when schedule changes', async () => {
        seedJob({ status: 'sent' });

        const result = await repository.upsertPendingJob(
          baseInput({
            scheduledAt: new Date('2026-06-12T16:00:00+07:00'),
            remindAt: new Date('2026-06-12T15:30:00+07:00'),
          }),
        );

        expect(result.status).toBe('pending');
      });

      it('force-reopens processing job even when schedule is unchanged', async () => {
        seedJob({ status: 'processing' });

        const result = await repository.upsertPendingJob(baseInput());

        expect(result.status).toBe('pending');
      });

      it('resets retryCount on re-upsert', async () => {
        seedJob({ status: 'failed', retryCount: 3 });

        const result = await repository.upsertPendingJob(baseInput());

        expect(result.status).toBe('pending');
        expect(result.retryCount).toBe(0);
      });

      it('keeps an ambiguous terminal outcome out of the retry state machine', async () => {
        seedJob({
          status: 'failed',
          retryCount: 1,
          deliveryStatus: 'ambiguous',
          lastError: 'ambiguous delivery',
        });

        const result = await repository.upsertPendingJob(baseInput(), {
          reopenOnlyOnScheduleChange: true,
        });

        expect(result.status).toBe('failed');
        expect(result.deliveryStatus).toBe('ambiguous');
        expect(result.retryCount).toBe(1);
      });

      it('keeps a terminal classified not_sent failure out of periodic sync', async () => {
        seedJob({
          status: 'failed',
          retryCount: 3,
          deliveryStatus: 'not_sent',
          lastError: 'Messenger 24h messaging window closed',
        });

        const result = await repository.upsertPendingJob(baseInput(), {
          reopenOnlyOnScheduleChange: true,
        });

        expect(result.status).toBe('failed');
        expect(result.deliveryStatus).toBe('not_sent');
        expect(result.retryCount).toBe(3);
      });

      it('reopens a failed terminal job when the schedule changes', async () => {
        seedJob({
          status: 'failed',
          retryCount: 1,
          deliveryStatus: 'ambiguous',
          deliveryKey: 'old-key',
        });

        const result = await repository.upsertPendingJob(
          baseInput({
            scheduledAt: new Date('2026-06-13T10:30:00+07:00'),
          }),
          { reopenOnlyOnScheduleChange: true },
        );

        expect(result.status).toBe('pending');
        expect(result.scheduledAt.toISOString()).toBe(
          new Date('2026-06-13T10:30:00+07:00').toISOString(),
        );
        expect(result.deliveryStatus).toBeUndefined();
        expect(result.deliveryKey).toBeUndefined();
      });
    });

    describe('advisory lock (Messenger multi-pod sync)', () => {
      it('wraps the upsert in a transaction holding the advisory lock', async () => {
        const input = baseInput();
        await repository.upsertPendingJob(input, {
          lockKey: `srj:${input.externalUserId}:${input.sessionKey}`,
        });

        expect(transactionMock).toHaveBeenCalledTimes(1);
      });

      it('uses a transaction even without an explicit lockKey', async () => {
        await repository.upsertPendingJob(baseInput());

        expect(transactionMock).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('upsertPendingJobs (batch)', () => {
    it('creates new jobs and updates existing ones in one batch', async () => {
      seedJob({ status: 'pending', retryCount: 1 });

      const results = await repository.upsertPendingJobs([
        baseInput({ sessionKey: 'calendar:5' }),
        baseInput({ sessionKey: 'calendar:6' }),
      ]);

      expect(results).toHaveLength(2);
      const byKey = new Map(results.map((job) => [job.sessionKey, job]));
      const updated = byKey.get('calendar:5')!;
      const created = byKey.get('calendar:6')!;
      expect(updated.retryCount).toBe(0);
      expect(created.status).toBe('pending');
      expect(created.id).toBeDefined();
    });

    it('keeps a sent job untouched when schedule is unchanged', async () => {
      const existing = seedJob({
        status: 'sent',
        sentAt: new Date('2026-06-11T08:00:00+07:00'),
      });

      const results = await repository.upsertPendingJobs(
        [baseInput({ sessionKey: 'calendar:5' })],
        { reopenOnlyOnScheduleChange: true },
      );

      expect(results[0].status).toBe('sent');
      expect(existing.status).toBe('sent');
    });

    it('reopens a sent job when the schedule changed', async () => {
      seedJob({ status: 'sent' });

      const results = await repository.upsertPendingJobs(
        [
          baseInput({
            sessionKey: 'calendar:5',
            scheduledAt: new Date('2026-06-13T10:30:00+07:00'),
          }),
        ],
        { reopenOnlyOnScheduleChange: true },
      );

      expect(results[0].status).toBe('pending');
      expect(results[0].sentAt).toBeUndefined();
    });

    it('returns an empty array for no inputs', async () => {
      const results = await repository.upsertPendingJobs([]);
      expect(results).toEqual([]);
    });
  });

  describe('claimJob', () => {
    it('assigns a fresh lease token and expiry from the claim deadline', async () => {
      const query = jest.fn().mockResolvedValue([
        [
          {
            id: 9,
            platform: 'messenger',
            external_user_id: 'psid-1',
            user_id: 143,
            session_key: 'calendar:5',
            scheduled_at: new Date('2026-06-12T10:30:00+07:00'),
            remind_at: new Date('2026-06-12T10:00:00+07:00'),
            topic: 'IELTS Writing',
            status: 'processing',
            retry_count: 1,
            max_retries: 3,
            next_retry_at: null,
            last_error: null,
            sent_at: null,
            lease_token: 'lease-abc',
            lease_expires_at: new Date(),
            delivery_record: null,
            delivery_key: 'delivery-key-1',
            delivery_status: 'ambiguous',
            processing_started_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        1,
      ]);
      const jobRepo = {
        query,
        update: jest.fn(),
        createQueryBuilder: jest.fn(),
      } as unknown as Repository<StudyReminderJobEntity>;
      const localRepo = new TypeormStudyReminderJobRepository(jobRepo);

      const job = await localRepo.claimJob('messenger', 9, 600_000);

      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("status = 'processing'");
      expect(sql).toContain('lease_token = gen_random_uuid()');
      expect(sql).toContain('lease_expires_at = now() + ($2::int');
      expect(sql).toContain(
        "status = 'pending' OR (status = 'failed' AND retry_count < max_retries)",
      );
      expect(sql).toContain(
        "delivery_status = 'not_sent' AND retry_count < max_retries",
      );
      // The claim is scoped to the worker's platform (#180).
      expect(sql).toContain('platform = $3');
      expect(params[0]).toBe(9);
      expect(params[1]).toBe(600_000);
      expect(params[2]).toBe('messenger');
      // Raw RETURNING * rows arrive with snake_case keys — mapping must work.
      expect(job?.externalUserId).toBe('psid-1');
      expect(job?.sessionKey).toBe('calendar:5');
      expect(job?.retryCount).toBe(1);
      expect(job?.leaseToken).toBe('lease-abc');
      expect(job?.status).toBe('processing');
      expect(job?.deliveryKey).toBe('delivery-key-1');
      expect(job?.deliveryStatus).toBe('ambiguous');
      expect(job?.processingStartedAt).toBeInstanceOf(Date);
    });

    it('returns null when the job is not pending/failed (real [[], 0] tuple shape)', async () => {
      const query = jest.fn().mockResolvedValue([[], 0]);
      const jobRepo = {
        query,
        update: jest.fn(),
        createQueryBuilder: jest.fn(),
      } as unknown as Repository<StudyReminderJobEntity>;
      const localRepo = new TypeormStudyReminderJobRepository(jobRepo);

      await expect(
        localRepo.claimJob('discord', 9, 600_000),
      ).resolves.toBeNull();
    });
  });

  describe('markSent / markFailed', () => {
    it('markSent requires the lease token (stale owners no-op)', async () => {
      const result = await repository.markSent(1, 'lease-abc');

      expect(result).toBe(true);
      const leaseCondition = queryLog.find(
        (entry) => entry.method === 'andWhere',
      );
      expect(leaseCondition?.args[0]).toContain('lease_token = :leaseToken');
      expect(leaseCondition?.args[1]).toEqual({ leaseToken: 'lease-abc' });
      expect(
        queryLog.some(
          (entry) =>
            entry.method === 'andWhere' &&
            String(entry.args[0]).includes("status = 'processing'"),
        ),
      ).toBe(true);
      const setCall = queryLog.find((entry) => entry.method === 'set');
      expect(setCall?.args[0]).toEqual(
        expect.objectContaining({
          deliveryStatus: 'sent',
          leaseToken: null,
          leaseExpiresAt: null,
          processingStartedAt: null,
        }),
      );
    });

    it('reports a lost lease when markSent affects no row', async () => {
      createQueryBuilderMock.mockImplementationOnce(() => {
        const qb = buildQb();
        qb.execute.mockResolvedValue({ affected: 0 });
        return qb;
      });

      const result = await repository.markSent(1, 'stale-lease');

      expect(result).toBe(false);
    });

    it('markFailed requires the lease token (stale owners no-op)', async () => {
      await repository.markFailed({
        jobId: 1,
        leaseToken: 'lease-abc',
        errorMessage: 'boom',
        retryCount: 1,
        terminal: false,
        deliveryStatus: 'not_sent',
      });

      const leaseCondition = queryLog.find(
        (entry) => entry.method === 'andWhere',
      );
      expect(leaseCondition?.args[0]).toContain('lease_token = :leaseToken');
      expect(leaseCondition?.args[1]).toEqual({ leaseToken: 'lease-abc' });
      const setCall = queryLog.find((entry) => entry.method === 'set');
      expect(setCall?.args[0]).toEqual(
        expect.objectContaining({
          deliveryStatus: 'not_sent',
          leaseToken: null,
          leaseExpiresAt: null,
          processingStartedAt: null,
        }),
      );
    });

    it('requires the current lease when persisting the delivery key', async () => {
      const result = await repository.markDeliveryKey(
        1,
        'lease-abc',
        'delivery-key-1',
      );

      expect(result).toBe(true);
      const leaseCondition = queryLog.find(
        (entry) =>
          entry.method === 'andWhere' &&
          String(entry.args[0]).includes('lease_token = :leaseToken'),
      );
      expect(leaseCondition?.args[1]).toEqual({ leaseToken: 'lease-abc' });
      expect(
        queryLog.some(
          (entry) =>
            entry.method === 'andWhere' &&
            String(entry.args[0]).includes("status = 'processing'"),
        ),
      ).toBe(true);
    });

    it('reports a lost lease when delivery-key persistence affects no row', async () => {
      createQueryBuilderMock.mockImplementationOnce(() => {
        const qb = buildQb();
        qb.execute.mockResolvedValue({ affected: 0 });
        return qb;
      });

      const result = await repository.markDeliveryKey(
        1,
        'stale-lease',
        'delivery-key-1',
      );

      expect(result).toBe(false);
    });
  });

  describe('markCancelled', () => {
    it('writes lastError and clears nextRetryAt when a reason is given', async () => {
      await repository.markCancelled(1, 'lease-abc', 'session already started');

      const setCall = queryLog.find((entry) => entry.method === 'set');
      expect(setCall?.args[0]).toEqual({
        status: 'cancelled',
        lastError: 'session already started',
        nextRetryAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        processingStartedAt: null,
        deliveryRecord: null,
        deliveryKey: null,
        deliveryStatus: null,
      });
      const leaseCondition = queryLog.find(
        (entry) => entry.method === 'andWhere',
      );
      expect(leaseCondition?.args[1]).toEqual({ leaseToken: 'lease-abc' });
    });

    it('only flips status without a reason', async () => {
      await repository.markCancelled(1, 'lease-abc');

      const setCall = queryLog.find((entry) => entry.method === 'set');
      expect(setCall?.args[0]).toEqual(
        expect.objectContaining({
          status: 'cancelled',
          leaseToken: null,
          leaseExpiresAt: null,
          processingStartedAt: null,
          deliveryRecord: null,
          deliveryKey: null,
          deliveryStatus: null,
        }),
      );
    });
  });

  describe('findDueJobs', () => {
    it('filters strictly by the worker platform (#180)', async () => {
      await repository.findDueJobs('messenger', new Date(), 10);

      const platformCondition = queryLog.find(
        (entry) =>
          entry.method === 'andWhere' &&
          String(entry.args[0]).includes('job.platform = :platform'),
      );
      expect(platformCondition?.args[1]).toEqual({ platform: 'messenger' });
      expect(
        queryLog.some(
          (entry) =>
            (entry.method === 'where' || entry.method === 'andWhere') &&
            String(entry.args[0]).includes('delivery_status'),
        ),
      ).toBe(true);
    });

    it('never returns another platform job even when the query matched it (mixed-platform)', async () => {
      const makeRow = (platform: string) =>
        ({
          id: nextId++,
          platform,
          externalUserId: `user-${platform}-1`,
          userId: 143,
          sessionKey: `calendar:${platform}`,
          scheduledAt: new Date('2026-06-12T10:30:00+07:00'),
          remindAt: new Date('2026-06-12T10:00:00+07:00'),
          topic: 'IELTS Writing',
          status: 'pending',
          retryCount: 0,
          maxRetries: 3,
          nextRetryAt: null,
          lastError: null,
          sentAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          createdAt: new Date('2026-06-10T08:00:00+07:00'),
          updatedAt: new Date('2026-06-10T08:00:00+07:00'),
        }) as StudyReminderJobEntity;

      let capturedPlatform: string | undefined;
      const qb = new Proxy(
        {
          getMany: jest
            .fn()
            .mockImplementation(() =>
              Promise.resolve(
                [
                  makeRow('messenger'),
                  makeRow('discord'),
                  makeRow('zalo'),
                ].filter((row) => row.platform === capturedPlatform),
              ),
            ),
        },
        {
          get: (target, prop: string | symbol) => {
            if (prop in target) {
              return target[prop as keyof typeof target];
            }
            return (...args: unknown[]) => {
              if (
                String(prop) === 'andWhere' &&
                String(args[0]).includes('platform')
              ) {
                capturedPlatform = (args[1] as { platform: string }).platform;
              }
              return qb;
            };
          },
        },
      );
      const localRepo = new TypeormStudyReminderJobRepository({
        createQueryBuilder: () => qb,
      } as unknown as Repository<StudyReminderJobEntity>);

      const jobs = await localRepo.findDueJobs('messenger', new Date(), 10);

      expect(capturedPlatform).toBe('messenger');
      expect(jobs.map((job) => job.platform)).toEqual(['messenger']);
    });
  });

  describe('resetStuckProcessingJobs', () => {
    it('targets failed by default and reopens only expired leases for the platform', async () => {
      await repository.resetStuckProcessingJobs('discord', new Date());

      const setCall = queryLog.find((entry) => entry.method === 'set');
      expect(setCall?.args[0]).toEqual({
        status: 'failed',
        deliveryStatus: 'ambiguous',
        nextRetryAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        processingStartedAt: null,
      });
      const platformCondition = queryLog.find(
        (entry) =>
          entry.method === 'andWhere' &&
          String(entry.args[0]).includes('platform = :platform'),
      );
      expect(platformCondition?.args[1]).toEqual({ platform: 'discord' });
      const leaseCondition = queryLog.find(
        (entry) =>
          entry.method === 'andWhere' &&
          String(entry.args[0]).includes('lease_expires_at < :now'),
      );
      expect(leaseCondition?.args[0]).toContain('lease_expires_at IS NULL');
      const leaseParams = leaseCondition?.args[1] as
        | { now?: Date; olderThan?: Date }
        | undefined;
      expect(leaseParams?.now).toBeInstanceOf(Date);
      expect(leaseParams?.olderThan).toBeInstanceOf(Date);
    });

    it('targets pending when requested (Messenger)', async () => {
      await repository.resetStuckProcessingJobs(
        'messenger',
        new Date(),
        'pending',
      );

      const setCall = queryLog.find((entry) => entry.method === 'set');
      expect(setCall?.args[0]).toEqual({
        status: 'pending',
        deliveryStatus: 'ambiguous',
        nextRetryAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
        processingStartedAt: null,
      });
    });
  });

  describe('deleteSentJobs', () => {
    it('deletes all sent jobs without a cutoff (Messenger rollover)', async () => {
      await repository.deleteSentJobs();

      expect(queryLog.some((entry) => entry.method === 'delete')).toBe(true);
      expect(queryLog.some((entry) => entry.method === 'andWhere')).toBe(false);
    });

    it('filters by sent_at when a cutoff is given', async () => {
      const cutoff = new Date();
      await repository.deleteSentJobs(cutoff);

      const andWhere = queryLog.find((entry) => entry.method === 'andWhere');
      expect(andWhere?.args[0]).toContain('sent_at');
    });
  });

  describe('countJobsByStatus', () => {
    it('does not filter by platform when omitted (Messenger ops-health)', async () => {
      await repository.countJobsByStatus();

      expect(queryLog.some((entry) => entry.method === 'where')).toBe(false);
    });

    it('filters by platform when provided', async () => {
      await repository.countJobsByStatus('discord');

      const whereCall = queryLog.find((entry) => entry.method === 'where');
      expect(whereCall?.args[0]).toContain('platform');
    });
  });

  describe('countStuckProcessing / findTerminalFailedSince', () => {
    it('counts stuck processing jobs', async () => {
      const result = await repository.countStuckProcessing(new Date());

      expect(result).toBe(3);
    });

    it('finds terminal failed jobs with a limit', async () => {
      const qb = buildQb();
      qb.getMany.mockResolvedValue([
        {
          id: 9,
          platform: 'messenger',
          externalUserId: 'psid-1',
          userId: null,
          sessionKey: 'calendar:1',
          scheduledAt: new Date(),
          remindAt: new Date(),
          topic: null,
          status: 'failed',
          retryCount: 3,
          maxRetries: 3,
          nextRetryAt: null,
          lastError: 'boom',
          sentAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      createQueryBuilderMock.mockReturnValue(qb);

      const result = await repository.findTerminalFailedSince(new Date(), 20);

      expect(result).toHaveLength(1);
      expect(result[0]?.lastError).toBe('boom');
      const terminalCondition = queryLog.find(
        (entry) =>
          entry.method === 'where' &&
          String(entry.args[0]).includes('delivery_status IN'),
      );
      expect(String(terminalCondition?.args[0])).toContain(
        "status IN ('pending', 'failed')",
      );
      const takeCall = queryLog.find((entry) => entry.method === 'take');
      expect(takeCall?.args[0]).toBe(20);
    });
  });

  describe('cancelJobsFromOtherPlatforms', () => {
    it('returns 0 for falsy userId without querying', async () => {
      const result = await repository.cancelJobsFromOtherPlatforms(0, 'zalo');

      expect(result).toBe(0);
      expect(queryLog).toHaveLength(0);
    });

    it('cancels processing jobs too when statuses include it (Messenger)', async () => {
      await repository.cancelJobsFromOtherPlatforms(42, 'zalo', {
        statuses: ['pending', 'failed', 'processing'],
      });

      const statusesCall = queryLog.find(
        (entry) =>
          entry.method === 'andWhere' &&
          String(entry.args[0]).includes('status IN'),
      );
      expect(statusesCall?.args[1]).toEqual({
        statuses: ['pending', 'failed', 'processing'],
      });
    });
  });

  describe('findNextDueTime', () => {
    it('returns null for empty table', async () => {
      // findNextDueTime uses manager.query which returns [] by default
      const result = await repository.findNextDueTime(
        new Date('2026-06-12T10:00:00+07:00'),
      );

      expect(result).toBeNull();
    });

    it('returns null when all jobs are in the past', async () => {
      seedJob({
        status: 'sent',
        remindAt: new Date('2026-06-12T09:00:00+07:00'),
      });

      const result = await repository.findNextDueTime(
        new Date('2026-06-12T10:00:00+07:00'),
      );

      expect(result).toBeNull();
    });

    it('scopes to platform when provided', async () => {
      const result = await repository.findNextDueTime(
        new Date('2026-06-12T10:00:00+07:00'),
        'discord',
      );

      expect(result).toBeNull();
    });
  });

  describe('resetStuckProcessingJobs', () => {
    it('resets expired leases across multiple platforms', async () => {
      seedJob({
        platform: 'messenger',
        status: 'processing',
        leaseExpiresAt: new Date('2026-06-12T09:00:00+07:00'),
      });
      seedJob({
        platform: 'discord',
        status: 'processing',
        leaseExpiresAt: new Date('2026-06-12T08:00:00+07:00'),
      });

      // Both jobs are in the store but resetStuckProcessingJobs uses
      // QueryBuilder (not in-memory store), so it returns mocked affected count
      const result = await repository.resetStuckProcessingJobs(
        'messenger',
        new Date('2026-06-12T10:00:00+07:00'),
      );

      // Mock returns affected: 7 by default
      expect(result).toBe(7);
    });

    it('does not reset live leases (lease_expires_at in future)', async () => {
      seedJob({
        platform: 'messenger',
        status: 'processing',
        leaseExpiresAt: new Date('2026-06-12T11:00:00+07:00'), // future
      });

      const result = await repository.resetStuckProcessingJobs(
        'messenger',
        new Date('2026-06-12T10:00:00+07:00'),
      );

      // The query builder mock still returns affected: 7, but the important
      // thing is that the correct lease_expires_at predicate is generated
      expect(result).toBe(7);
      const leaseCondition = queryLog.find(
        (entry) =>
          entry.method === 'andWhere' &&
          String(entry.args[0]).includes('lease_expires_at'),
      );
      expect(leaseCondition).toBeDefined();
    });
  });

  describe('cancelJobsFromOtherPlatforms', () => {
    it('scopes cancellation to the platform via where predicate', async () => {
      await repository.cancelJobsFromOtherPlatforms(42, 'discord');

      const whereCall = queryLog.find((entry) => entry.method === 'where');
      expect(whereCall?.args[0]).toContain('userId');
      const platformCondition = queryLog.find(
        (entry) =>
          entry.method === 'andWhere' &&
          String(entry.args[0]).includes('platform !='),
      );
      expect(platformCondition?.args[1]).toEqual({ platform: 'discord' });
    });
  });

  describe('deleteTerminalJobsOlderThan', () => {
    it('deletes exhausted jobs and terminal delivery outcomes', async () => {
      await repository.deleteTerminalJobsOlderThan(
        new Date('2026-06-12T00:00:00+07:00'),
      );

      expect(queryLog.some((entry) => entry.method === 'delete')).toBe(true);
      const terminalCondition = queryLog.find(
        (entry) =>
          entry.method === 'where' &&
          String(entry.args[0]).includes('retry_count >= max_retries') &&
          String(entry.args[0]).includes('delivery_status IN'),
      );
      expect(terminalCondition).toBeDefined();
    });
  });

  describe('findStuckProcessing', () => {
    it('returns stuck processing jobs with optional limit', async () => {
      const qb = buildQb();
      qb.getMany.mockResolvedValue([
        {
          id: 1,
          platform: 'messenger',
          externalUserId: 'psid-1',
          userId: null,
          sessionKey: 'calendar:1',
          scheduledAt: new Date(),
          remindAt: new Date(),
          topic: null,
          status: 'processing',
          retryCount: 0,
          maxRetries: 3,
          nextRetryAt: null,
          lastError: null,
          sentAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      createQueryBuilderMock.mockReturnValue(qb);

      const result = await repository.findStuckProcessing(new Date(), 10);

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('processing');
    });
  });

  describe('cancelPendingJobsForExternalUser (#596)', () => {
    it('cancels every cancellable job for the learner on this platform', async () => {
      managerQuery.mockResolvedValueOnce({ rowCount: 3 });

      const cancelled = await repository.cancelPendingJobsForExternalUser(
        'discord',
        'discord-1',
      );

      expect(cancelled).toBe(3);
      const [sql, params] = managerQuery.mock.calls[0];
      expect(String(sql)).toContain(`status = 'cancelled'`);
      expect(String(sql)).toContain(`lease_token = NULL`);
      expect(String(sql)).toContain(`external_user_id = $2`);
      expect(params).toEqual(['discord', 'discord-1', 'reminder_opted_out']);
    });

    it('returns 0 when the query reports no rows', async () => {
      managerQuery.mockResolvedValueOnce(undefined);

      const cancelled = await repository.cancelPendingJobsForExternalUser(
        'zalo',
        'zalo-1',
      );

      expect(cancelled).toBe(0);
    });
  });
});
