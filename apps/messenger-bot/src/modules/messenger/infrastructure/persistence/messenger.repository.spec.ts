import { Repository } from 'typeorm';
import { buildPocPsidToken } from '@messenger/shared/config/poc.constants';
import {
  MessageLogEntity,
  ScheduledReportClaimEntity,
  UserPlatformMappingEntity,
} from '@messenger/infrastructure/database/entities';
import { MessengerRepository } from './messenger.repository';

describe('MessengerRepository.upsertPsidUserLink', () => {
  const buildRepo = () => {
    const managerQuery = jest.fn();
    const mappingRepo = {
      manager: { query: managerQuery },
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn((input: Partial<UserPlatformMappingEntity>) => input),
      update: jest.fn(),
      createQueryBuilder: jest.fn(),
    } as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {} as unknown as Repository<MessageLogEntity>;
    const claimRepo = {} as unknown as Repository<ScheduledReportClaimEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo, claimRepo);
    return { repo, managerQuery };
  };

  it('reactivates an INACTIVE row, then upserts atomically via ON CONFLICT', async () => {
    const { repo, managerQuery } = buildRepo();
    managerQuery
      .mockResolvedValueOnce([]) // UPDATE INACTIVE (no-op)
      .mockResolvedValueOnce([
        {
          id: 7,
          user_id: 143,
          platform: 'messenger',
          external_user_id: 'psid-1',
          notification_messages_token: buildPocPsidToken('psid-1'),
          topic: 'ielts',
          cadence: 'weekly',
          status: 'ACTIVE',
          created_at: new Date('2026-01-01T00:00:00.000Z'),
          updated_at: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);

    const result = await repo.upsertPsidUserLink({
      psid: 'psid-1',
      userId: 143,
      topic: 'ielts',
      cadence: 'weekly',
    });

    expect(result).not.toBeNull();
    expect(result!.psid).toBe('psid-1');
    expect(result!.userId).toBe(143);
    expect(managerQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('UPDATE user_platform_mappings'),
      expect.any(Array),
    );
    expect(managerQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "ON CONFLICT (platform, external_user_id)\n          WHERE status = 'ACTIVE' AND external_user_id IS NOT NULL",
      ),
      expect.any(Array),
    );
  });

  it('returns null when CAS guard blocks the update (#383)', async () => {
    const { repo, managerQuery } = buildRepo();
    managerQuery
      .mockResolvedValueOnce([]) // UPDATE INACTIVE (no-op)
      .mockResolvedValueOnce([]); // CAS guard blocked — RETURNING empty

    const result = await repo.upsertPsidUserLink({
      psid: 'psid-1',
      userId: 99,
      topic: 'ielts',
      cadence: 'weekly',
    });

    expect(result).toBeNull();
  });
});

describe('MessengerRepository.tryClaimScheduledReport', () => {
  const buildRepo = () => {
    const managerQuery = jest.fn();
    const mappingRepo = {} as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {} as unknown as Repository<MessageLogEntity>;

    // Simulates Postgres ON CONFLICT semantics for the claim upsert:
    // fresh key -> insert claimed (returned); existing released row ->
    // reclaimed (returned); existing claimed/sent row -> blocked.
    managerQuery.mockImplementation((_sql: string, params: unknown[]) => {
      const externalUserId = params[1] as string;
      const reportDate = params[2] as string;
      const key = `messenger:${externalUserId}:${reportDate}`;
      const existing = claimStore.get(key);

      if (existing) {
        if (existing.status === 'released') {
          existing.status = 'claimed';
          existing.leaseToken = 'lease-1-reclaimed';
          return [{ id: existing.id, lease_token: existing.leaseToken }];
        }
        return [];
      }

      claimStore.set(key, {
        id: nextId,
        status: 'claimed',
        leaseToken: `lease-${nextId}`,
      });
      nextId += 1;
      return [{ id: nextId - 1, lease_token: `lease-${nextId - 1}` }];
    });

    const claimRepo = {
      manager: { query: managerQuery },
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    } as unknown as Repository<ScheduledReportClaimEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo, claimRepo);
    return { repo, managerQuery };
  };

  let claimStore: Map<
    string,
    { id: number; status: string; leaseToken?: string }
  >;
  let nextId: number;

  beforeEach(() => {
    claimStore = new Map();
    nextId = 1;
  });

  it('reclaims a released claim after a transient failure', async () => {
    const { repo } = buildRepo();
    await repo.tryClaimScheduledReport(
      {
        externalUserId: 'psid-1',
        reportDate: '2026-08-14',
      },
      120_000,
    );
    claimStore.set('messenger:psid-1:2026-08-14', {
      id: 1,
      status: 'released',
      leaseToken: 'lease-1',
    });

    const reclaimed = await repo.tryClaimScheduledReport(
      {
        externalUserId: 'psid-1',
        reportDate: '2026-08-14',
      },
      120_000,
    );

    expect(reclaimed).toEqual({
      claimed: true,
      leaseToken: 'lease-1-reclaimed',
    });
    expect(claimStore.get('messenger:psid-1:2026-08-14')?.status).toBe(
      'claimed',
    );
  });

  it('does not reclaim a sent claim', async () => {
    const { repo } = buildRepo();
    claimStore.set('messenger:psid-1:2026-08-14', {
      id: 1,
      status: 'sent',
      leaseToken: 'lease-1',
    });

    const reclaimed = await repo.tryClaimScheduledReport(
      {
        externalUserId: 'psid-1',
        reportDate: '2026-08-14',
      },
      120_000,
    );

    expect(reclaimed).toEqual({ claimed: false });
  });

  it('regression: issued SQL only reclaims released rows', async () => {
    const { repo, managerQuery } = buildRepo();
    await repo.tryClaimScheduledReport(
      {
        externalUserId: 'psid-1',
        reportDate: '2026-08-14',
      },
      120_000,
    );

    const issuedSql = (managerQuery.mock.calls[0] as unknown[])[0] as string;
    expect(issuedSql).toContain('DO UPDATE');
    expect(issuedSql).toContain(
      "WHERE scheduled_report_claims.status = 'released'",
    );
  });
});

describe('MessengerRepository scheduled report lease ownership', () => {
  const buildRepo = () => {
    const queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    const claimRepo = {
      createQueryBuilder: jest.fn(() => queryBuilder),
    } as unknown as Repository<ScheduledReportClaimEntity>;
    const repo = new MessengerRepository(
      {} as Repository<UserPlatformMappingEntity>,
      {} as Repository<MessageLogEntity>,
      claimRepo,
    );
    return { repo, queryBuilder };
  };

  it('requires the current lease token to mark a claim sent', async () => {
    const { repo, queryBuilder } = buildRepo();

    const marked = await repo.markScheduledReportClaimSent(
      { externalUserId: 'psid-1', reportDate: '2026-08-14' },
      'stale-token',
    );

    expect(marked).toBe(false);
    const whereSql = (
      queryBuilder.andWhere.mock.calls as Array<
        [string, Record<string, unknown>?]
      >
    )
      .map(([sql]) => sql)
      .join('\n');
    expect(whereSql).toContain('lease_token = :leaseToken');
  });

  it('recovers expired and legacy claims with one platform-scoped update', async () => {
    const { repo, queryBuilder } = buildRepo();
    const now = new Date('2026-08-14T10:00:00.000Z');
    const olderThan = new Date('2026-08-14T08:00:00.000Z');

    await repo.releaseExpiredScheduledReportClaims(now, olderThan);

    const whereSql = (
      queryBuilder.andWhere.mock.calls as Array<
        [string, Record<string, unknown>?]
      >
    )
      .map(([sql]) => sql)
      .join('\n');
    expect(whereSql).toContain('lease_expires_at < :now');
    expect(whereSql).toContain(
      'lease_expires_at IS NULL AND updated_at < :olderThan',
    );
  });
});

describe('MessengerRepository.deleteMessageLogsOlderThan', () => {
  it('scopes message log deletion to Messenger using bounded batch', async () => {
    const queryMock = jest.fn().mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    const deleteExecuteMock = jest.fn().mockResolvedValue({ affected: 2 });
    const deleteWhereMock = jest.fn(() => ({
      execute: deleteExecuteMock,
    }));
    const mappingRepo = {} as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {
      query: queryMock,
      createQueryBuilder: jest.fn(() => ({
        delete: () => ({
          from: () => ({ where: deleteWhereMock }),
        }),
      })),
    } as unknown as Repository<MessageLogEntity>;
    const claimRepo = {} as unknown as Repository<ScheduledReportClaimEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo, claimRepo);
    const cutoff = new Date('2026-08-18T00:00:00.000Z');

    const deleted = await repo.deleteMessageLogsOlderThan(cutoff);

    expect(deleted).toBe(2);
    // Verify the SELECT query uses bounded batch with platform scope
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id FROM message_logs'),
      ['messenger', cutoff, 1000],
    );
    // Verify the DELETE uses the returned IDs
    expect(deleteWhereMock).toHaveBeenCalledWith('id IN (:...ids)', {
      ids: [1, 2],
    });
  });

  it('returns 0 when no matching rows exist', async () => {
    const queryMock = jest.fn().mockResolvedValueOnce([]);
    const mappingRepo = {} as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {
      query: queryMock,
      createQueryBuilder: jest.fn(),
    } as unknown as Repository<MessageLogEntity>;
    const claimRepo = {} as unknown as Repository<ScheduledReportClaimEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo, claimRepo);

    const deleted = await repo.deleteMessageLogsOlderThan(new Date());

    expect(deleted).toBe(0);
    expect(logRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe('MessengerRepository platform-scoped user lookups (#191)', () => {
  const buildRepoWithFindOne = (findOne: jest.Mock) => {
    const mappingRepo = {
      findOne,
      createQueryBuilder: jest.fn(),
      manager: { query: jest.fn() },
    } as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {} as unknown as Repository<MessageLogEntity>;
    const claimRepo = {} as unknown as Repository<ScheduledReportClaimEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo, claimRepo);
    return { repo };
  };

  it('scopes findActiveMappingByUserId to the messenger platform', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const { repo } = buildRepoWithFindOne(findOne);

    await repo.findActiveMappingByUserId(143);

    expect(findOne).toHaveBeenCalledWith({
      where: { platform: 'messenger', userId: 143, status: 'ACTIVE' },
      order: { id: 'DESC' },
    });
  });

  it('returns null when only sibling-platform mappings exist for the userId', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const { repo } = buildRepoWithFindOne(findOne);

    const result = await repo.findActiveMappingByUserId(143);

    expect(result).toBeNull();
  });

  it('returns the mapping when the userId has an active messenger row', async () => {
    const findOne = jest.fn().mockResolvedValue({
      id: 7,
      userId: 143,
      platform: 'messenger',
      externalUserId: 'psid-1',
      topic: 'ielts',
      cadence: 'weekly',
      status: 'ACTIVE',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const { repo } = buildRepoWithFindOne(findOne);

    const result = await repo.findActiveMappingByUserId(143);

    expect(result?.psid).toBe('psid-1');
    expect(result?.userId).toBe(143);
  });

  const buildRepoWithQueryBuilder = () => {
    const where = jest.fn().mockReturnThis();
    const andWhere = jest.fn().mockReturnThis();
    const orderBy = jest.fn().mockReturnThis();
    const take = jest.fn().mockReturnThis();
    const getMany = jest.fn().mockResolvedValue([]);
    const createQueryBuilder = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      where,
      andWhere,
      orderBy,
      take,
      getMany,
    });
    const mappingRepo = {
      createQueryBuilder,
      findOne: jest.fn(),
      manager: { query: jest.fn() },
    } as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {} as unknown as Repository<MessageLogEntity>;
    const claimRepo = {} as unknown as Repository<ScheduledReportClaimEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo, claimRepo);
    return { repo, andWhere };
  };

  it('scopes findActiveSubscribedMappings to the messenger platform', async () => {
    const { repo, andWhere } = buildRepoWithQueryBuilder();

    await repo.findActiveSubscribedMappings();

    expect(andWhere).toHaveBeenCalledWith('mapping.platform = :platform', {
      platform: 'messenger',
    });
  });

  it('scopes findActiveSubscribedMappingsPage with keyset cursor', async () => {
    const { repo, andWhere } = buildRepoWithQueryBuilder();

    await repo.findActiveSubscribedMappingsPage(100, 500);

    expect(andWhere).toHaveBeenCalledWith('mapping.id > :afterId', {
      afterId: 100,
    });
    expect(andWhere).toHaveBeenCalledWith('mapping.platform = :platform', {
      platform: 'messenger',
    });
  });

  it('scopes findActiveMappingsPage to the messenger platform', async () => {
    const { repo, andWhere } = buildRepoWithQueryBuilder();

    await repo.findActiveMappingsPage(0, 100);

    expect(andWhere).toHaveBeenCalledWith('mapping.platform = :platform', {
      platform: 'messenger',
    });
  });
});

describe('MessengerRepository.logMessage (#262)', () => {
  it('persists message log metadata without messageText', async () => {
    const create = jest.fn().mockImplementation((payload) => ({
      id: 1,
      ...payload,
      createdAt: new Date('2026-08-20T10:00:00.000Z'),
    }));
    const save = jest
      .fn()
      .mockImplementation((entity) => Promise.resolve(entity));
    const mappingRepo = {} as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {
      create,
      save,
    } as unknown as Repository<MessageLogEntity>;
    const claimRepo = {} as unknown as Repository<ScheduledReportClaimEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo, claimRepo);

    const result = await repo.logMessage({
      userId: 143,
      psid: 'psid-123',
      messageType: 'FREE_FORM_CHAT_IN',
      status: 'SENT',
    });

    expect(create).toHaveBeenCalledWith({
      userId: 143,
      platform: 'messenger',
      externalUserId: 'psid-123',
      messageType: 'FREE_FORM_CHAT_IN',
      status: 'SENT',
      errorMessage: null,
    });
    expect(save).toHaveBeenCalled();
    expect(result).toEqual({
      id: 1,
      userId: 143,
      psid: 'psid-123',
      messageType: 'FREE_FORM_CHAT_IN',
      status: 'SENT',
      errorMessage: undefined,
      createdAt: '2026-08-20T10:00:00.000Z',
    });
    expect((result as Record<string, unknown>).messageText).toBeUndefined();
    expect(
      (create.mock.calls[0][0] as Record<string, unknown>).messageText,
    ).toBeUndefined();
  });
});
