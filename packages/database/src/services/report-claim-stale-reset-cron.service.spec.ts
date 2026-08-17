import { ConfigService } from '@nestjs/config';
import type { PgAdvisoryLockService } from '@wispace/bot-common';
import type { ReportClaimRepositoryPort } from '@wispace/scheduler-core';
import {
  DEFAULT_REPORT_CLAIM_LEASE_MS,
  ReportClaimStaleResetCronService,
  readReportClaimLeaseMs,
} from './report-claim-stale-reset-cron.service';

describe('ReportClaimStaleResetCronService', () => {
  const buildService = (configValue?: string, lockResult: unknown = 3) => {
    const configService = {
      get: jest.fn().mockReturnValue(configValue),
    } as unknown as ConfigService;
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
      configService,
      claimRepository,
      { withLock } as unknown as PgAdvisoryLockService,
      { platform: 'discord', lockId: 884_200_935 },
    );
    return { service, releaseExpiredScheduledReportClaims, withLock };
  };

  it('releases expired claims under the platform advisory lock', async () => {
    const { service, releaseExpiredScheduledReportClaims, withLock } =
      buildService('120000');

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

  it('uses the two-hour default for missing or invalid configuration', () => {
    const configService = {
      get: jest.fn().mockReturnValue('invalid'),
    } as unknown as ConfigService;

    expect(readReportClaimLeaseMs(configService)).toBe(
      DEFAULT_REPORT_CLAIM_LEASE_MS,
    );
  });
});
