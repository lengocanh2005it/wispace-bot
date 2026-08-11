/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import { ConfigService } from '@nestjs/config';
import { ReportCronLeaderService } from './report-cron-leader.service';
import type { CronLeaderLeasePort } from '../ports/cron-leader-lease.port';

function buildConfig(overrides: Record<string, string> = {}) {
  return {
    get: jest.fn(
      (key: string) =>
        ({
          CRON_LEADER_ENABLED: undefined,
          CRON_LEADER_INSTANCE_ID: undefined,
          INSTANCE_ID: 'pod-a',
          ...overrides,
        })[key],
    ),
  } as unknown as ConfigService;
}

describe('ReportCronLeaderService', () => {
  it('runs everywhere when leader election is disabled (lock protects)', async () => {
    const service = new ReportCronLeaderService(buildConfig());

    await expect(service.shouldRunScheduledReportCron()).resolves.toBe(true);
  });

  it('claims the lease when leader election is enabled', async () => {
    const lease: CronLeaderLeasePort = {
      claim: jest.fn().mockResolvedValue(true),
      heartbeat: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ReportCronLeaderService(
      buildConfig({ CRON_LEADER_ENABLED: 'true' }),
      lease,
    );

    await expect(service.shouldRunScheduledReportCron()).resolves.toBe(true);
    expect(lease.claim).toHaveBeenCalledWith('report', 'pod-a');
  });

  it('skips when another instance holds the lease', async () => {
    const lease: CronLeaderLeasePort = {
      claim: jest.fn().mockResolvedValue(false),
      heartbeat: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ReportCronLeaderService(
      buildConfig({ CRON_LEADER_ENABLED: 'true' }),
      lease,
    );

    await expect(service.shouldRunScheduledReportCron()).resolves.toBe(false);
  });

  it('heartbeats only when leader election is enabled', async () => {
    const lease: CronLeaderLeasePort = {
      claim: jest.fn().mockResolvedValue(true),
      heartbeat: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ReportCronLeaderService(buildConfig(), lease);

    await service.heartbeat();
    expect(lease.heartbeat).not.toHaveBeenCalled();

    const enabled = new ReportCronLeaderService(
      buildConfig({ CRON_LEADER_ENABLED: 'true' }),
      lease,
    );
    await enabled.heartbeat();
    expect(lease.heartbeat).toHaveBeenCalledWith('report', 'pod-a');
  });
});
