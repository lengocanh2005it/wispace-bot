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
        seedJob({ status: 'processing' });

        const result = await repository.upsertPendingJob(
          baseInput({
            scheduledAt: new Date('2026-06-12T16:00:00+07:00'),
            remindAt: new Date('2026-06-12T15:30:00+07:00'),
          }),
          options,
        );

        expect(result.status).toBe('pending');
        expect(result.retryCount).toBe(0);
      });

      it('updates pending job schedule in place and keeps retryCount', async () => {
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
        expect(result.retryCount).toBe(2);
      });
    });

    describe('default behavior (Discord/Zalo)', () => {
      it('keeps sent job even when schedule changes', async () => {
        seedJob({ status: 'sent' });

        const result = await repository.upsertPendingJob(
          baseInput({
            scheduledAt: new Date('2026-06-12T16:00:00+07:00'),
            remindAt: new Date('2026-06-12T15:30:00+07:00'),
          }),
        );

        expect(result.status).toBe('sent');
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
    });

    describe('advisory lock (Messenger multi-pod sync)', () => {
      it('wraps the upsert in a transaction holding the advisory lock', async () => {
        const input = baseInput();
        await repository.upsertPendingJob(input, {
          lockKey: `srj:${input.externalUserId}:${input.sessionKey}`,
        });

        expect(transactionMock).toHaveBeenCalledTimes(1);
      });

      it('does not open a transaction without a lockKey', async () => {
        await repository.upsertPendingJob(baseInput());

        expect(transactionMock).not.toHaveBeenCalled();
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
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);
      const jobRepo = {
        query,
        update: jest.fn(),
        createQueryBuilder: jest.fn(),
      } as unknown as Repository<StudyReminderJobEntity>;
      const localRepo = new TypeormStudyReminderJobRepository(jobRepo);

      const job = await localRepo.claimJob(9, 600_000);

      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("status = 'processing'");
      expect(sql).toContain('lease_token = gen_random_uuid()');
      expect(sql).toContain('lease_expires_at = now() + ($2::int');
      expect(sql).toContain("status IN ('pending', 'failed')");
      expect(params[0]).toBe(9);
      expect(params[1]).toBe(600_000);
      // Raw RETURNING * rows arrive with snake_case keys — mapping must work.
      expect(job?.externalUserId).toBe('psid-1');
      expect(job?.sessionKey).toBe('calendar:5');
      expect(job?.retryCount).toBe(1);
      expect(job?.leaseToken).toBe('lease-abc');
      expect(job?.status).toBe('processing');
    });

    it('returns null when the job is not pending/failed', async () => {
      const query = jest.fn().mockResolvedValue([]);
      const jobRepo = {
        query,
        update: jest.fn(),
        createQueryBuilder: jest.fn(),
      } as unknown as Repository<StudyReminderJobEntity>;
      const localRepo = new TypeormStudyReminderJobRepository(jobRepo);

      await expect(localRepo.claimJob(9, 600_000)).resolves.toBeNull();
    });
  });

  describe('markSent / markFailed', () => {
    it('markSent requires the lease token (stale owners no-op)', async () => {
      await repository.markSent(1, 'lease-abc');

      const leaseCondition = queryLog.find(
        (entry) => entry.method === 'andWhere',
      );
      expect(leaseCondition?.args[0]).toContain('lease_token = :leaseToken');
      expect(leaseCondition?.args[1]).toEqual({ leaseToken: 'lease-abc' });
    });

    it('markFailed requires the lease token (stale owners no-op)', async () => {
      await repository.markFailed({
        jobId: 1,
        leaseToken: 'lease-abc',
        errorMessage: 'boom',
        retryCount: 1,
        terminal: false,
      });

      const leaseCondition = queryLog.find(
        (entry) => entry.method === 'andWhere',
      );
      expect(leaseCondition?.args[0]).toContain('lease_token = :leaseToken');
      expect(leaseCondition?.args[1]).toEqual({ leaseToken: 'lease-abc' });
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
      });
      const leaseCondition = queryLog.find(
        (entry) => entry.method === 'andWhere',
      );
      expect(leaseCondition?.args[1]).toEqual({ leaseToken: 'lease-abc' });
    });

    it('only flips status without a reason', async () => {
      await repository.markCancelled(1, 'lease-abc');

      const setCall = queryLog.find((entry) => entry.method === 'set');
      expect(setCall?.args[0]).toEqual({ status: 'cancelled' });
    });
  });

  describe('resetStuckProcessingJobs', () => {
    it('targets failed by default and reopens only expired leases', async () => {
      await repository.resetStuckProcessingJobs(new Date());

      const setCall = queryLog.find((entry) => entry.method === 'set');
      expect(setCall?.args[0]).toEqual({ status: 'failed' });
      const leaseCondition = queryLog.find(
        (entry) => entry.method === 'andWhere',
      );
      expect(leaseCondition?.args[0]).toContain('lease_expires_at < :now');
      expect(leaseCondition?.args[0]).toContain('lease_expires_at IS NULL');
      const leaseParams = leaseCondition?.args[1] as
        | { now?: Date; olderThan?: Date }
        | undefined;
      expect(leaseParams?.now).toBeInstanceOf(Date);
      expect(leaseParams?.olderThan).toBeInstanceOf(Date);
    });

    it('targets pending when requested (Messenger)', async () => {
      await repository.resetStuckProcessingJobs(new Date(), 'pending');

      const setCall = queryLog.find((entry) => entry.method === 'set');
      expect(setCall?.args[0]).toEqual({ status: 'pending' });
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
});
