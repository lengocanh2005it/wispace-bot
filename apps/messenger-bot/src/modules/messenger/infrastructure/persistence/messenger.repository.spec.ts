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

    expect(result.psid).toBe('psid-1');
    expect(result.userId).toBe(143);
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
  it('scopes message log deletion to Messenger', async () => {
    const logDelete = jest
      .fn<Promise<{ affected: number }>, [unknown]>()
      .mockResolvedValue({ affected: 2 });
    const mappingRepo = {} as unknown as Repository<UserPlatformMappingEntity>;
    const logRepo = {
      delete: logDelete,
    } as unknown as Repository<MessageLogEntity>;
    const claimRepo = {} as unknown as Repository<ScheduledReportClaimEntity>;
    const repo = new MessengerRepository(mappingRepo, logRepo, claimRepo);
    const cutoff = new Date('2026-08-18T00:00:00.000Z');

    await repo.deleteMessageLogsOlderThan(cutoff);

    const criteria = logDelete.mock.calls[0]?.[0] as
      | { platform?: string; createdAt?: { value?: Date } }
      | undefined;
    expect(criteria?.platform).toBe('messenger');
    expect(criteria?.createdAt?.value).toBe(cutoff);
  });
});
