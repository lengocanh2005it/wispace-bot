import { Repository } from 'typeorm';
import { ScheduledReportClaimEntity } from '../entities/scheduled-report-claim.entity';
import type { Platform } from '../types';
import { PlatformReportClaimRepository } from './platform-report-claim.repository';

type ClaimRow = {
  id: number;
  status: 'claimed' | 'sent' | 'released';
  userId: number | null;
  leaseToken?: string;
};

const PLATFORM: Platform = 'zalo';

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
          return [{ id: existing.id, lease_token: existing.leaseToken }];
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
      return [{ id: nextId - 1, lease_token: leaseToken }];
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

  it('does not steal a concurrently held claim (claimed stays claimed)', async () => {
    const first = await claim();
    const second = await claim();

    expect(first.claimed).toBe(true);
    expect(second).toEqual({ claimed: false });
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
      first.leaseToken,
    );
    expect(released).toBe(true);

    const second = await claim();
    expect(second).toEqual({
      claimed: true,
      leaseToken: 'lease-1-reclaimed',
    });

    const staleMarked = await repository.markScheduledReportClaimSent(
      { externalUserId: 'zalo-1', reportDate: '2026-08-14' },
      first.leaseToken,
    );
    const staleReleased = await repository.releaseScheduledReportClaim(
      { externalUserId: 'zalo-1', reportDate: '2026-08-14' },
      first.leaseToken,
    );

    expect(staleMarked).toBe(false);
    expect(staleReleased).toBe(false);

    const currentMarked = await repository.markScheduledReportClaimSent(
      { externalUserId: 'zalo-1', reportDate: '2026-08-14' },
      second.leaseToken,
    );

    expect(currentMarked).toBe(true);
    expect(claimStore.get(claimKey('zalo-1', '2026-08-14'))?.status).toBe(
      'sent',
    );
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
