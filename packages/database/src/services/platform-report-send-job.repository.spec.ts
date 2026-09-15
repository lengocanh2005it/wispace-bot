import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { PlatformReportSendJobRepository } from './platform-report-send-job.repository';
import { ReportSendJobEntity } from '../entities/report-send-job.entity';

const PLATFORMS = ['messenger', 'discord'] as const;

type QueryBuilderMock = {
  update: jest.Mock;
  set: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  limit: jest.Mock;
  execute: jest.Mock;
  getMany: jest.Mock;
  getCount: jest.Mock;
};

function buildQueryBuilder(): QueryBuilderMock {
  const builder = {} as QueryBuilderMock;
  builder.update = jest.fn().mockReturnValue(builder);
  builder.set = jest.fn().mockReturnValue(builder);
  builder.where = jest.fn().mockReturnValue(builder);
  builder.andWhere = jest.fn().mockReturnValue(builder);
  builder.orderBy = jest.fn().mockReturnValue(builder);
  builder.limit = jest.fn().mockReturnValue(builder);
  builder.execute = jest.fn().mockResolvedValue({ affected: 0 });
  builder.getMany = jest.fn().mockResolvedValue([]);
  builder.getCount = jest.fn().mockResolvedValue(0);
  return builder;
}

function buildRepository(
  platform: (typeof PLATFORMS)[number],
  overrides: Partial<{
    query: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  }> = {},
) {
  const builder = buildQueryBuilder();
  const jobRepo = {
    query: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((input: Partial<ReportSendJobEntity>) => input),
    save: jest.fn((input: ReportSendJobEntity) => input),
    update: jest.fn().mockResolvedValue({ affected: 0 }),
    createQueryBuilder: jest.fn(() => builder),
    ...overrides,
  } as unknown as Repository<ReportSendJobEntity>;

  return {
    repository: new PlatformReportSendJobRepository(platform, jobRepo),
    jobRepo,
    builder,
  };
}

describe('PlatformReportSendJobRepository', () => {
  it.each(PLATFORMS)(
    'records retry failures for the configured %s platform',
    async (platform) => {
      const save = jest.fn((entity: ReportSendJobEntity) => entity);
      const create = jest.fn((input: Partial<ReportSendJobEntity>) => ({
        id: 7,
        createdAt: new Date('2026-06-12T01:00:00.000Z'),
        updatedAt: new Date('2026-06-12T01:00:00.000Z'),
        ...input,
      }));
      const { repository, jobRepo } = buildRepository(platform, {
        create,
        save,
      });

      const job = await repository.recordRetryableFailure({
        platform,
        externalUserId: 'external-1',
        userId: 143,
        examDate: '2026-06-15',
        firstAttemptDate: '2026-06-12',
        maxRetries: 3,
        nextRetryAt: new Date('2026-06-12T01:15:00.000Z'),
        errorMessage: 'temporary upstream failure',
      });

      expect(job).toMatchObject({
        platform,
        externalUserId: 'external-1',
        retryCount: 1,
        status: 'failed',
      });
      expect(jobRepo.findOne).toHaveBeenCalledWith({
        where: {
          platform,
          externalUserId: 'external-1',
          examDate: '2026-06-15',
        },
      });
      expect(save).toHaveBeenCalled();
    },
  );

  it('increments existing failures and clears the next retry time at the terminal attempt', async () => {
    const existing = {
      id: 7,
      platform: 'messenger' as const,
      externalUserId: 'external-1',
      userId: null,
      examDate: '2026-06-15',
      firstAttemptDate: '2026-06-12',
      status: 'failed' as const,
      retryCount: 2,
      maxRetries: 3,
      nextRetryAt: new Date('2026-06-12T01:15:00.000Z'),
      lastError: 'old',
      sentAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      createdAt: new Date('2026-06-12T01:00:00.000Z'),
      updatedAt: new Date('2026-06-12T01:15:00.000Z'),
    } as ReportSendJobEntity;
    const save = jest.fn((entity: ReportSendJobEntity) => entity);
    const { repository } = buildRepository('messenger', {
      findOne: jest.fn().mockResolvedValue(existing),
      save,
    });

    const job = await repository.recordRetryableFailure({
      platform: 'messenger',
      externalUserId: 'external-1',
      examDate: '2026-06-15',
      firstAttemptDate: '2026-06-12',
      maxRetries: 3,
      nextRetryAt: new Date('2026-06-12T01:30:00.000Z'),
      errorMessage: 'final failure',
    });

    expect(job.retryCount).toBe(3);
    expect(job.nextRetryAt).toBeUndefined();
    expect(job.status).toBe('failed');
    expect(save).toHaveBeenCalledWith(existing);
  });

  it('does not overwrite a job that has already been sent', async () => {
    const existing = {
      platform: 'discord' as const,
      externalUserId: 'external-1',
      examDate: '2026-06-15',
      status: 'sent' as const,
      retryCount: 1,
    } as ReportSendJobEntity;
    const save = jest.fn();
    const create = jest.fn();
    const { repository } = buildRepository('discord', {
      findOne: jest.fn().mockResolvedValue(existing),
      save,
      create,
    });

    await repository.recordRetryableFailure({
      platform: 'discord',
      externalUserId: 'external-1',
      examDate: '2026-06-15',
      firstAttemptDate: '2026-06-12',
      maxRetries: 3,
      nextRetryAt: new Date('2026-06-12T01:30:00.000Z'),
      errorMessage: 'late failure',
    });

    expect(save).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each(PLATFORMS)(
    'claims a %s job atomically and maps a real UPDATE RETURNING tuple',
    async (platform) => {
      const query = jest.fn().mockResolvedValue([
        [
          {
            id: 7,
            platform,
            external_user_id: 'external-1',
            user_id: null,
            exam_date: '2026-06-15',
            first_attempt_date: '2026-06-12',
            status: 'processing',
            retry_count: 1,
            max_retries: 3,
            next_retry_at: null,
            last_error: null,
            sent_at: null,
            lease_token: 'lease-1',
            lease_expires_at: new Date('2026-06-15T01:00:00.000Z'),
            created_at: new Date('2026-06-12T01:00:00.000Z'),
            updated_at: new Date('2026-06-15T00:00:00.000Z'),
          },
        ],
        1,
      ]);
      const { repository, jobRepo } = buildRepository(platform, { query });

      const job = await repository.claimJob(7, 600_000);

      expect(job).toMatchObject({
        id: 7,
        platform,
        externalUserId: 'external-1',
        leaseToken: 'lease-1',
      });
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('RETURNING *'),
        [7, platform, 600_000],
      );
      expect(jobRepo.query).toBe(query);
    },
  );

  it('returns null when an atomic claim matches no row', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const { repository } = buildRepository('messenger', { query });

    await expect(repository.claimJob(7, 600_000)).resolves.toBeNull();
  });

  it('also maps a flat raw row returned by a driver without an UPDATE tuple', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        id: 8,
        platform: 'messenger',
        external_user_id: 'external-2',
        exam_date: '2026-06-16',
        first_attempt_date: '2026-06-13',
        status: 'processing',
        retry_count: 1,
        max_retries: 3,
        lease_token: 'lease-2',
        created_at: new Date('2026-06-13T01:00:00.000Z'),
        updated_at: new Date('2026-06-16T00:00:00.000Z'),
      },
    ]);
    const { repository } = buildRepository('messenger', { query });

    await expect(repository.claimJob(8, 600_000)).resolves.toMatchObject({
      id: 8,
      externalUserId: 'external-2',
      leaseToken: 'lease-2',
    });
  });

  it.each(PLATFORMS)('scopes due jobs to %s', async (platform) => {
    const { repository, builder } = buildRepository(platform);

    await repository.findDueJobs(new Date('2026-06-15T00:00:00.000Z'), 12);

    expect(builder.where).toHaveBeenCalledWith('job.platform = :platform', {
      platform,
    });
    expect(builder.limit).toHaveBeenCalledWith(12);
  });

  it.each(PLATFORMS)(
    'fences markSent by platform and lease token for %s',
    async (platform) => {
      const { repository, builder } = buildRepository(platform);

      await repository.markSent(7, 'lease-1');

      const predicates = builder.andWhere.mock.calls
        .map(([sql]) => sql)
        .join('\n');
      expect(predicates).toContain('platform = :platform');
      expect(predicates).toContain('lease_token = :leaseToken');
    },
  );

  it.each(PLATFORMS)(
    'does not let a stale lease owner change a %s job',
    async (platform) => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      try {
        const { repository, builder } = buildRepository(platform);

        await repository.markSent(7, 'stale-lease');
        await repository.markFailed({
          jobId: 7,
          leaseToken: 'stale-lease',
          errorMessage: 'late failure',
          retryCount: 2,
          terminal: false,
          nextRetryAt: new Date('2026-06-15T00:15:00.000Z'),
        });

        expect(builder.execute).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(`platform=${platform}`),
        );
      } finally {
        warn.mockRestore();
      }
    },
  );

  it.each(PLATFORMS)(
    'can reclaim a %s job after stuck processing recovery',
    async (platform) => {
      let recovered = false;
      const query = jest.fn().mockImplementation(() =>
        recovered
          ? [
              [
                {
                  id: 7,
                  platform,
                  external_user_id: 'external-1',
                  user_id: null,
                  exam_date: '2026-06-15',
                  first_attempt_date: '2026-06-12',
                  status: 'processing',
                  retry_count: 1,
                  max_retries: 3,
                  next_retry_at: null,
                  last_error: null,
                  sent_at: null,
                  lease_token: 'lease-after-recovery',
                  lease_expires_at: new Date('2026-06-15T01:00:00.000Z'),
                  created_at: new Date('2026-06-12T01:00:00.000Z'),
                  updated_at: new Date('2026-06-15T00:00:00.000Z'),
                },
              ],
              1,
            ]
          : [[], 0],
      );
      const { repository, builder } = buildRepository(platform, { query });
      builder.execute.mockImplementation(() => {
        recovered = true;
        return Promise.resolve({ affected: 1 });
      });

      await expect(repository.claimJob(7, 600_000)).resolves.toBeNull();
      await expect(
        repository.resetStuckProcessingJobs(
          new Date('2026-06-14T00:00:00.000Z'),
        ),
      ).resolves.toBe(1);
      await expect(repository.claimJob(7, 600_000)).resolves.toMatchObject({
        platform,
        status: 'processing',
        leaseToken: 'lease-after-recovery',
      });
    },
  );

  it('keeps markFailed token optional while always scoping the platform', async () => {
    const { repository, builder } = buildRepository('messenger');

    await repository.markFailed({
      jobId: 7,
      errorMessage: 'temporary failure',
      retryCount: 2,
      terminal: false,
      nextRetryAt: new Date('2026-06-15T00:15:00.000Z'),
    });

    const predicates = builder.andWhere.mock.calls
      .map(([sql]) => sql)
      .join('\n');
    expect(predicates).toContain('platform = :platform');
    expect(predicates).not.toContain('lease_token = :leaseToken');
  });

  it('fences token-bearing markFailed writes and truncates persisted errors', async () => {
    const { repository, builder } = buildRepository('discord');

    await repository.markFailed({
      jobId: 7,
      leaseToken: 'lease-1',
      errorMessage: 'x'.repeat(3_000),
      retryCount: 3,
      terminal: true,
    });

    const predicates = builder.andWhere.mock.calls
      .map(([sql]) => sql)
      .join('\n');
    expect(predicates).toContain('lease_token = :leaseToken');
    expect(builder.set).toHaveBeenCalledWith(
      expect.objectContaining({
        lastError: expect.any(String),
        nextRetryAt: null,
      }),
    );
    expect(builder.set.mock.calls[0][0].lastError).toHaveLength(2_000);
  });

  it.each(PLATFORMS)(
    'marks the configured platform sent by external identity and exam date (%s)',
    async (platform) => {
      const update = jest.fn().mockResolvedValue({ affected: 1 });
      const { repository } = buildRepository(platform, { update });

      await repository.markSentByExternalUserExamDate(
        'external-1',
        '2026-06-15',
      );

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          platform,
          externalUserId: 'external-1',
          examDate: '2026-06-15',
        }),
        expect.objectContaining({ status: 'sent' }),
      );
    },
  );

  it.each(PLATFORMS)(
    'scopes stuck recovery and terminal counts to %s',
    async (platform) => {
      const { repository, builder } = buildRepository(platform);

      await repository.resetStuckProcessingJobs(
        new Date('2026-06-14T00:00:00.000Z'),
      );
      await repository.countTerminalFailedSince(
        new Date('2026-06-14T00:00:00.000Z'),
      );

      const predicates = builder.where.mock.calls
        .concat(builder.andWhere.mock.calls)
        .map(([sql]) => sql)
        .join('\n');
      expect(predicates).toContain('platform = :platform');
    },
  );
});
