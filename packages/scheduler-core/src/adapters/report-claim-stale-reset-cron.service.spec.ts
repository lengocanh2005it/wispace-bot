import type { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import type { ReportClaimRepositoryPort } from '../ports/report-claim.repository.port';
import { ReportClaimStaleResetCronService } from './report-claim-stale-reset-cron.service';

describe('ReportClaimStaleResetCronService', () => {
  const buildService = (claimLeaseMs?: number, lockResult: unknown = 3) => {
    const releaseExpiredScheduledReportClaims = jest.fn().mockResolvedValue(3);
    const claimRepository = {
      releaseExpiredScheduledReportClaims,
    } as unknown as ReportClaimRepositoryPort;
    const withLock = jest
      .fn()
      .mockImplementation(
        async (_lockId: number, fn: () => Promise<unknown>) =>
          lockResult === null ? null : fn(),
      );
    const service = new ReportClaimStaleResetCronService(
      claimRepository,
      { withLock } as unknown as PgAdvisoryLockService,
      {
        getOutboxSettings: jest
          .fn()
          .mockReturnValue({ claimLeaseMs: claimLeaseMs ?? 7_200_000 }),
      } as never,
      { platform: 'discord', lockId: 884_200_935 },
    );
    return { service, releaseExpiredScheduledReportClaims, withLock };
  };

  it('releases expired claims under the platform advisory lock', async () => {
    const { service, releaseExpiredScheduledReportClaims, withLock } =
      buildService(120000);

    await service.handleStaleReset();

    expect(withLock).toHaveBeenCalledWith(884_200_935, expect.any(Function));
    expect(releaseExpiredScheduledReportClaims).toHaveBeenCalledWith(
      expect.any(Date),
      expect.any(Date),
    );
    const [now, olderThan] = releaseExpiredScheduledReportClaims.mock
      .calls[0] as [Date, Date];
    expect(now.getTime() - olderThan.getTime()).toBe(120000);
  });

  it('skips when another pod owns the lock', async () => {
    const { service, releaseExpiredScheduledReportClaims } = buildService(
      undefined,
      null,
    );

    await service.handleStaleReset();

    expect(releaseExpiredScheduledReportClaims).not.toHaveBeenCalled();
  });
});
