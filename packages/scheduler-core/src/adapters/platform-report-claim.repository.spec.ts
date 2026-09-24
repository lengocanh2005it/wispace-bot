import { Repository } from 'typeorm';
import {
  LearnerScheduledReportClaimEntity,
  ScheduledReportClaimEntity,
} from '@wispace/database';
import type { Platform } from '@wispace/contracts';
import { PlatformReportClaimRepository } from './platform-report-claim.repository';

type ClaimRow = {
  id: number;
  status: 'claimed' | 'sent' | 'released';
  userId: number | null;
  leaseToken?: string;
};

const PLATFORM: Platform = 'zalo';

it.each(['messenger', 'discord'] as const)(
  'configures the shared claim adapter for %s',
  async (platform) => {
    const query = jest.fn().mockResolvedValue([]);
    const claimRepo = {
      manager: { query },
      createQueryBuilder: jest.fn(),
    } as unknown as Repository<ScheduledReportClaimEntity>;
    const repository = new PlatformReportClaimRepository(platform, claimRepo);

    await repository.tryClaimScheduledReport(
      { externalUserId: 'external-1', reportDate: '2026-08-14' },
      120_000,
    );

    expect(query).toHaveBeenCalledWith(expect.any(String), [
      platform,
      'external-1',
      '2026-08-14',
      null,
      120_000,
    ]);
  },
);

describe('PlatformReportClaimRepository.tryClaimScheduledReport', () => {
  let repository: PlatformReportClaimRepository;
  let query: jest.Mock;
  let claimStore: Map<string, ClaimRow>;
  let nextId: number;
  let update: jest.Mock;
  let findOne: jest.Mock;
  let queryBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    execute: jest.Mock;
    pendingPatch?: { status: ClaimRow['status'] };
  };

  const claimKey = (externalUserId: string, reportDate: string) =>
    `${PLATFORM}:${externalUserId}:${reportDate}`;

  const buildRepo = () => {
    claimStore = new Map();
    nextId = 1;
    update = jest.fn();
    findOne = jest.fn();
    queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn((patch: { status: ClaimRow['status'] }) => {
        queryBuilder.pendingPatch = patch;
        return queryBuilder;
      }),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn(() => {
        const andWhereCalls = queryBuilder.andWhere.mock.calls as Array<
          [string, Record<string, unknown>?]
        >;
        const staleReset = andWhereCalls.some(([sql]) =>
          String(sql).includes('lease_expires_at'),
        );
        if (staleReset) return Promise.resolve({ affected: 1 });

        const tokenCall = [...andWhereCalls]
          .reverse()
          .find(([sql]) => String(sql).includes('lease_token'));
        const leaseToken = tokenCall?.[1]?.leaseToken as string | undefined;
        const row = claimStore.get(claimKey('zalo-1', '2026-08-14'));
        if (!row || (leaseToken && row.leaseToken !== leaseToken)) {
          return Promise.resolve({ affected: 0 });
        }

        row.status = queryBuilder.pendingPatch?.status ?? row.status;
        return Promise.resolve({ affected: 1 });
      }),
    };

    // Simulates Postgres ON CONFLICT semantics for the claim upsert:
    // fresh key -> insert claimed (returned); existing released row ->
    // reclaimed (returned); existing claimed/sent row -> blocked.
    query = jest.fn((_sql: string, params: unknown[]) => {
      const externalUserId = params[1] as string;
      const reportDate = params[2] as string;
      const key = claimKey(externalUserId, reportDate);
      const existing = claimStore.get(key);

      if (existing) {
        if (existing.status === 'released') {
          existing.status = 'claimed';
          existing.leaseToken = `lease-${existing.id}-reclaimed`;
          return [
            {
              id: existing.id,
              lease_token: existing.leaseToken,
              delivery_key: null,
            },
          ];
        }
        return [];
      }

      const leaseToken = `lease-${nextId}`;
      claimStore.set(key, {
        id: nextId,
        status: 'claimed',
        userId: null,
        leaseToken,
      });
      nextId += 1;
      return [{ id: nextId - 1, lease_token: leaseToken, delivery_key: null }];
    });

    const claimRepo = {
      manager: { query },
      update,
      findOne,
      createQueryBuilder: jest.fn(() => queryBuilder),
    } as unknown as Repository<ScheduledReportClaimEntity>;

    repository = new PlatformReportClaimRepository(PLATFORM, claimRepo);
  };

  beforeEach(() => buildRepo());

  const claim = (externalUserId = 'zalo-1') =>
    (
      repository as unknown as {
        tryClaimScheduledReport: (
          params: {
            externalUserId: string;
            reportDate: string;
          },
          leaseMs: number,
        ) => Promise<{ claimed: boolean; leaseToken?: string }>;
      }
    ).tryClaimScheduledReport(
      { externalUserId, reportDate: '2026-08-14' },
      120_000,
    );

  it('claims a fresh platform/user/date slot and returns a lease token', async () => {
    const claimed = await claim();

    expect(claimed).toEqual({ claimed: true, leaseToken: 'lease-1' });
    expect(claimStore.get(claimKey('zalo-1', '2026-08-14'))?.status).toBe(
      'claimed',
    );
  });

  it('uses one atomic learner/date claim for linked multi-platform reports', async () => {
    const learnerQuery = jest
      .fn()
      .mockResolvedValueOnce([
        {
          lease_token: 'learner-lease-1',
          delivery_record: null,
          delivery_key: null,
        },
      ])
      .mockResolvedValueOnce([]);
    const learnerRepo = {
      manager: { query: learnerQuery },
    } as unknown as Repository<LearnerScheduledReportClaimEntity>;
    const claimRepo = {
      manager: { query: jest.fn() },
    } as unknown as Repository<ScheduledReportClaimEntity>;
    const linkedRepository = new PlatformReportClaimRepository(
      PLATFORM,
      claimRepo,
      learnerRepo,
    );

    const [first, second] = await Promise.all([
      linkedRepository.tryClaimScheduledReport(
        { externalUserId: 'zalo-1', userId: 143, reportDate: '2026-08-14' },
        120_000,
      ),
      linkedRepository.tryClaimScheduledReport(
        {
          externalUserId: 'discord-1',
          userId: 143,
          reportDate: '2026-08-14',
        },
        120_000,
      ),
    ]);

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(learnerQuery.mock.calls[0][0]).toContain(
      'ON CONFLICT (user_id, report_date, report_type)',
    );
    expect(learnerQuery.mock.calls[0][1]).toEqual([
      143,
      '2026-08-14',
      'zalo',
      'zalo-1',
      120_000,
    ]);
  });

  it('checks a learner claim regardless of which platform owns delivery', async () => {
    const learnerFindOne = jest.fn().mockResolvedValue({ userId: 143 });
    const learnerRepo = {
      findOne: learnerFindOne,
      manager: { query: jest.fn() },
    } as unknown as Repository<LearnerScheduledReportClaimEntity>;
    const linkedRepository = new PlatformReportClaimRepository(
      PLATFORM,
      {} as Repository<ScheduledReportClaimEntity>,
      learnerRepo,
    );

    await expect(
      linkedRepository.hasSentScheduledReportOn('zalo-1', '2026-08-14', 143),
    ).resolves.toBe(true);

    expect(learnerFindOne).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: 143,
        reportType: 'scheduled',
        status: 'sent',
      }),
    });
    expect(learnerFindOne.mock.calls[0][0].where).not.toHaveProperty(
      'platform',
    );
  });

  it('does not steal a concurrently held claim (claimed stays claimed)', async () => {
    const first = await claim();
    const second = await claim();

    expect(first.claimed).toBe(true);
    expect(second).toEqual({ claimed: false });
  });

  it('allows only one concurrent userId-less platform fallback claim', async () => {
    const [first, second] = await Promise.all([claim(), claim()]);

    expect([first.claimed, second.claimed].sort()).toEqual([false, true]);
    expect(query.mock.calls[0][0]).toContain(
      'ON CONFLICT (platform, external_user_id, report_date)',
    );
    expect(query.mock.calls[0][1]).toEqual([
      'zalo',
      'zalo-1',
      '2026-08-14',
      null,
      120_000,
    ]);
  });

  it('reclaims a released claim for the same platform/user/date', async () => {
    await claim();
    update.mockImplementation((_where: unknown, patch: { status: string }) => {
      const row = claimStore.get(claimKey('zalo-1', '2026-08-14'));
      if (row && patch.status === 'released') {
        row.status = 'released';
      }
      return Promise.resolve(undefined);
    });
    await (
      repository as unknown as {
        releaseScheduledReportClaim: (
          params: { externalUserId: string; reportDate: string },
          leaseToken: string,
        ) => Promise<boolean>;
      }
    ).releaseScheduledReportClaim(
      { externalUserId: 'zalo-1', reportDate: '2026-08-14' },
      'lease-1',
    );

    const reclaimed = await claim();

    expect(reclaimed).toEqual({
      claimed: true,
      leaseToken: 'lease-1-reclaimed',
    });
    expect(claimStore.get(claimKey('zalo-1', '2026-08-14'))?.status).toBe(
      'claimed',
    );
  });

  it('keeps sent claims non-reclaimable', async () => {
    await claim();
    update.mockImplementation((_where: unknown, patch: { status: string }) => {
      const row = claimStore.get(claimKey('zalo-1', '2026-08-14'));
      if (row && patch.status === 'sent') {
        row.status = 'sent';
      }
      return Promise.resolve(undefined);
    });
    await (
      repository as unknown as {
        markScheduledReportClaimSent: (
          params: { externalUserId: string; reportDate: string },
          leaseToken: string,
        ) => Promise<boolean>;
      }
    ).markScheduledReportClaimSent(
      { externalUserId: 'zalo-1', reportDate: '2026-08-14' },
      'lease-1',
    );

    const reclaimed = await claim();

    expect(reclaimed).toEqual({ claimed: false });
    expect(claimStore.get(claimKey('zalo-1', '2026-08-14'))?.status).toBe(
      'sent',
    );
  });

  it('regression: issued SQL only reclaims released rows', async () => {
    await claim();

    const issuedSql = (query.mock.calls[0] as unknown[])[0] as string;
    expect(issuedSql).toContain('DO UPDATE');
    expect(issuedSql).toContain(
      "WHERE scheduled_report_claims.status = 'released'",
    );
    expect(issuedSql).toContain('delivery_key');
  });

  it('requires the current lease token for mark-sent transitions', async () => {
    queryBuilder.execute.mockResolvedValueOnce({ affected: 0 });

    const marked = await (
      repository as unknown as {
        markScheduledReportClaimSent: (
          params: { externalUserId: string; reportDate: string },
          leaseToken: string,
        ) => Promise<boolean>;
      }
    ).markScheduledReportClaimSent(
      { externalUserId: 'zalo-1', reportDate: '2026-08-14' },
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

  it('prevents a stale worker from changing a reclaimed claim', async () => {
    const first = await claim();
    expect(first).toEqual({ claimed: true, leaseToken: 'lease-1' });

    const released = await repository.releaseScheduledReportClaim(
      { externalUserId: 'zalo-1', reportDate: '2026-08-14' },
      first.leaseToken!,
    );
    expect(released).toBe(true);

    const second = await claim();
    expect(second).toEqual({
      claimed: true,
      leaseToken: 'lease-1-reclaimed',
    });

    const staleMarked = await repository.markScheduledReportClaimSent(
      { externalUserId: 'zalo-1', reportDate: '2026-08-14' },
      first.leaseToken!,
    );
    const staleReleased = await repository.releaseScheduledReportClaim(
      { externalUserId: 'zalo-1', reportDate: '2026-08-14' },
      first.leaseToken!,
    );

    expect(staleMarked).toBe(false);
    expect(staleReleased).toBe(false);

    const currentMarked = await repository.markScheduledReportClaimSent(
      { externalUserId: 'zalo-1', reportDate: '2026-08-14' },
      second.leaseToken!,
    );

    expect(currentMarked).toBe(true);
    expect(claimStore.get(claimKey('zalo-1', '2026-08-14'))?.status).toBe(
      'sent',
    );
  });

  it('persists the stable delivery key when marking a claim sent', async () => {
    await claim();

    const marked = await repository.markScheduledReportClaimSent(
      { externalUserId: 'zalo-1', reportDate: '2026-08-14' },
      'lease-1',
      'sent',
      'report-key:chunk:0',
    );

    expect(marked).toBe(true);
    expect(queryBuilder.pendingPatch).toMatchObject({
      status: 'sent',
      deliveryKey: 'report-key:chunk:0',
    });
  });

  it('releases only expired leases and legacy claims past the cutoff', async () => {
    const now = new Date('2026-08-14T10:00:00.000Z');
    const olderThan = new Date('2026-08-14T08:00:00.000Z');

    const released = await (
      repository as unknown as {
        releaseExpiredScheduledReportClaims: (
          now: Date,
          olderThan: Date,
        ) => Promise<number>;
      }
    ).releaseExpiredScheduledReportClaims(now, olderThan);

    expect(released).toBe(1);
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

type PlatformClaimHarness = {
  repository: PlatformReportClaimRepository;
  query: jest.Mock;
  row: { status: ClaimRow['status']; leaseToken: string } | undefined;
  queryBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    execute: jest.Mock;
    pendingPatch?: { status?: ClaimRow['status'] };
  };
};

function buildPlatformClaimHarness(platform: Platform): PlatformClaimHarness {
  let nextLease = 1;
  const harness = {} as PlatformClaimHarness;
  const query = jest.fn((_sql: string, params: unknown[]) => {
    expect(params[0]).toBe(platform);
    if (!harness.row) {
      harness.row = { status: 'claimed', leaseToken: `lease-${nextLease++}` };
      return [
        {
          id: 1,
          lease_token: harness.row.leaseToken,
          delivery_record: null,
          delivery_key: null,
        },
      ];
    }
    if (harness.row.status === 'released') {
      harness.row.status = 'claimed';
      harness.row.leaseToken = `lease-${nextLease++}`;
      return [
        {
          id: 1,
          lease_token: harness.row.leaseToken,
          delivery_record: null,
          delivery_key: null,
        },
      ];
    }
    return [];
  });

  const queryBuilder: PlatformClaimHarness['queryBuilder'] = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn((patch: { status?: ClaimRow['status'] }) => {
      queryBuilder.pendingPatch = patch;
      return queryBuilder;
    }),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn(() => {
      const predicates = queryBuilder.andWhere.mock.calls as Array<
        [string, Record<string, unknown>?]
      >;
      if (
        predicates.some(([sql]) => String(sql).includes('lease_expires_at'))
      ) {
        if (harness.row) harness.row.status = 'released';
        return Promise.resolve({ affected: harness.row ? 1 : 0 });
      }
      const tokenCall = [...predicates]
        .reverse()
        .find(([sql]) => String(sql).includes('lease_token'));
      const token = tokenCall?.[1]?.leaseToken as string | undefined;
      if (!harness.row || (token && harness.row.leaseToken !== token)) {
        return Promise.resolve({ affected: 0 });
      }
      harness.row.status =
        queryBuilder.pendingPatch?.status ?? harness.row.status;
      return Promise.resolve({ affected: 1 });
    }),
  };

  harness.query = query;
  harness.queryBuilder = queryBuilder;
  harness.repository = new PlatformReportClaimRepository(platform, {
    manager: { query },
    createQueryBuilder: jest.fn(() => queryBuilder),
  } as unknown as Repository<ScheduledReportClaimEntity>);
  return harness;
}

describe.each(['messenger', 'discord', 'zalo'] as const)(
  'PlatformReportClaimRepository semantic behavior (%s)',
  (platform) => {
    const params = {
      externalUserId: 'external-1',
      reportDate: '2026-08-14',
    };

    it('claims a fresh slot and returns a lease token', async () => {
      const harness = buildPlatformClaimHarness(platform);

      await expect(
        harness.repository.tryClaimScheduledReport(params, 120_000),
      ).resolves.toMatchObject({ claimed: true, leaseToken: 'lease-1' });
      expect(harness.row?.status).toBe('claimed');
    });

    it('reclaims a released slot while keeping sent slots closed', async () => {
      const harness = buildPlatformClaimHarness(platform);
      const first = await harness.repository.tryClaimScheduledReport(
        params,
        120_000,
      );

      await expect(
        harness.repository.releaseScheduledReportClaim(
          params,
          first.leaseToken!,
        ),
      ).resolves.toBe(true);
      const reclaimed = await harness.repository.tryClaimScheduledReport(
        params,
        120_000,
      );
      expect(reclaimed.claimed).toBe(true);

      await expect(
        harness.repository.markScheduledReportClaimSent(
          params,
          reclaimed.leaseToken!,
        ),
      ).resolves.toBe(true);
      await expect(
        harness.repository.tryClaimScheduledReport(params, 120_000),
      ).resolves.toEqual({ claimed: false });
    });

    it('fences stale lease transitions after a reclaim', async () => {
      const harness = buildPlatformClaimHarness(platform);
      const first = await harness.repository.tryClaimScheduledReport(
        params,
        120_000,
      );
      await harness.repository.releaseScheduledReportClaim(
        params,
        first.leaseToken!,
      );
      const second = await harness.repository.tryClaimScheduledReport(
        params,
        120_000,
      );

      await expect(
        harness.repository.markScheduledReportClaimSent(
          params,
          first.leaseToken!,
        ),
      ).resolves.toBe(false);
      await expect(
        harness.repository.releaseScheduledReportClaim(
          params,
          first.leaseToken!,
        ),
      ).resolves.toBe(false);
      await expect(
        harness.repository.markScheduledReportClaimSent(
          params,
          second.leaseToken!,
        ),
      ).resolves.toBe(true);
    });

    it('reopens an expired claim for a later worker', async () => {
      const harness = buildPlatformClaimHarness(platform);
      await harness.repository.tryClaimScheduledReport(params, 120_000);

      await expect(
        harness.repository.releaseExpiredScheduledReportClaims(
          new Date('2026-08-14T10:00:00.000Z'),
          new Date('2026-08-14T08:00:00.000Z'),
        ),
      ).resolves.toBe(1);
      await expect(
        harness.repository.tryClaimScheduledReport(params, 120_000),
      ).resolves.toMatchObject({ claimed: true });
    });
  },
);

it('keeps learner-level dedupe when the first delivery uses Messenger', async () => {
  let learnerClaimed = false;
  const learnerQuery = jest.fn((_sql?: string, _params?: unknown[]) => {
    if (learnerClaimed) return [];
    learnerClaimed = true;
    return [
      {
        lease_token: 'learner-lease-1',
        delivery_record: null,
        delivery_key: null,
      },
    ];
  });
  const learnerRepo = {
    manager: { query: learnerQuery },
  } as unknown as Repository<LearnerScheduledReportClaimEntity>;
  const claimRepo = {
    manager: { query: jest.fn() },
  } as unknown as Repository<ScheduledReportClaimEntity>;
  const messenger = new PlatformReportClaimRepository(
    'messenger',
    claimRepo,
    learnerRepo,
  );
  const discord = new PlatformReportClaimRepository(
    'discord',
    claimRepo,
    learnerRepo,
  );

  const [first, second] = await Promise.all([
    messenger.tryClaimScheduledReport(
      { externalUserId: 'messenger-1', userId: 143, reportDate: '2026-08-14' },
      120_000,
    ),
    discord.tryClaimScheduledReport(
      { externalUserId: 'discord-1', userId: 143, reportDate: '2026-08-14' },
      120_000,
    ),
  ]);

  expect(first.claimed).toBe(true);
  expect(second.claimed).toBe(false);
  expect(learnerQuery.mock.calls[0][1]).toEqual([
    143,
    '2026-08-14',
    'messenger',
    'messenger-1',
    120_000,
  ]);
});
