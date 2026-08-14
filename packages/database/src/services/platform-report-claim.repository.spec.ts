import { Repository } from 'typeorm';
import { ScheduledReportClaimEntity } from '../entities/scheduled-report-claim.entity';
import type { Platform } from '../types';
import { PlatformReportClaimRepository } from './platform-report-claim.repository';

type ClaimRow = {
  id: number;
  status: 'claimed' | 'sent' | 'released';
  userId: number | null;
};

const PLATFORM: Platform = 'zalo';

describe('PlatformReportClaimRepository.tryClaimScheduledReport', () => {
  let repository: PlatformReportClaimRepository;
  let query: jest.Mock;
  let claimStore: Map<string, ClaimRow>;
  let nextId: number;
  let update: jest.Mock;
  let findOne: jest.Mock;

  const claimKey = (externalUserId: string, reportDate: string) =>
    `${PLATFORM}:${externalUserId}:${reportDate}`;

  const buildRepo = () => {
    claimStore = new Map();
    nextId = 1;
    update = jest.fn();
    findOne = jest.fn();

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
          return [{ id: existing.id }];
        }
        return [];
      }

      claimStore.set(key, { id: nextId, status: 'claimed', userId: null });
      nextId += 1;
      return [{ id: nextId - 1 }];
    });

    const claimRepo = {
      manager: { query },
      update,
      findOne,
    } as unknown as Repository<ScheduledReportClaimEntity>;

    repository = new PlatformReportClaimRepository(PLATFORM, claimRepo);
  };

  beforeEach(() => buildRepo());

  it('claims a fresh platform/user/date slot', async () => {
    const claimed = await repository.tryClaimScheduledReport({
      externalUserId: 'zalo-1',
      reportDate: '2026-08-14',
    });

    expect(claimed).toBe(true);
    expect(claimStore.get(claimKey('zalo-1', '2026-08-14'))?.status).toBe(
      'claimed',
    );
  });

  it('does not steal a concurrently held claim (claimed stays claimed)', async () => {
    const first = await repository.tryClaimScheduledReport({
      externalUserId: 'zalo-1',
      reportDate: '2026-08-14',
    });
    const second = await repository.tryClaimScheduledReport({
      externalUserId: 'zalo-1',
      reportDate: '2026-08-14',
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('reclaims a released claim for the same platform/user/date', async () => {
    await repository.tryClaimScheduledReport({
      externalUserId: 'zalo-1',
      reportDate: '2026-08-14',
    });
    update.mockImplementation((_where: unknown, patch: { status: string }) => {
      const row = claimStore.get(claimKey('zalo-1', '2026-08-14'));
      if (row && patch.status === 'released') {
        row.status = 'released';
      }
      return Promise.resolve(undefined);
    });
    await repository.releaseScheduledReportClaim({
      externalUserId: 'zalo-1',
      reportDate: '2026-08-14',
    });

    const reclaimed = await repository.tryClaimScheduledReport({
      externalUserId: 'zalo-1',
      reportDate: '2026-08-14',
    });

    expect(reclaimed).toBe(true);
    expect(claimStore.get(claimKey('zalo-1', '2026-08-14'))?.status).toBe(
      'claimed',
    );
  });

  it('keeps sent claims non-reclaimable', async () => {
    await repository.tryClaimScheduledReport({
      externalUserId: 'zalo-1',
      reportDate: '2026-08-14',
    });
    update.mockImplementation((_where: unknown, patch: { status: string }) => {
      const row = claimStore.get(claimKey('zalo-1', '2026-08-14'));
      if (row && patch.status === 'sent') {
        row.status = 'sent';
      }
      return Promise.resolve(undefined);
    });
    await repository.markScheduledReportClaimSent({
      externalUserId: 'zalo-1',
      reportDate: '2026-08-14',
    });

    const reclaimed = await repository.tryClaimScheduledReport({
      externalUserId: 'zalo-1',
      reportDate: '2026-08-14',
    });

    expect(reclaimed).toBe(false);
    expect(claimStore.get(claimKey('zalo-1', '2026-08-14'))?.status).toBe(
      'sent',
    );
  });

  it('regression: issued SQL only reclaims released rows', async () => {
    await repository.tryClaimScheduledReport({
      externalUserId: 'zalo-1',
      reportDate: '2026-08-14',
    });

    const issuedSql = (query.mock.calls[0] as unknown[])[0] as string;
    expect(issuedSql).toContain('DO UPDATE');
    expect(issuedSql).toContain(
      "WHERE scheduled_report_claims.status = 'released'",
    );
  });
});
