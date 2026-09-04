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
    const service = new ReportCronLeaderService(
      buildConfig(),
      undefined,
      'messenger',
    );

    await expect(service.shouldRunScheduledReportCron()).resolves.toBe(true);
  });

  it('claims its platform-scoped lease when leader election is enabled', async () => {
    const lease: CronLeaderLeasePort = {
      claim: jest.fn().mockResolvedValue(true),
      heartbeat: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ReportCronLeaderService(
      buildConfig({ CRON_LEADER_ENABLED: 'true' }),
      lease,
      'messenger',
    );

    await expect(service.shouldRunScheduledReportCron()).resolves.toBe(true);
    expect(lease.claim).toHaveBeenCalledWith('report:messenger', 'pod-a');
  });

  it('skips when another instance holds the lease', async () => {
    const lease: CronLeaderLeasePort = {
      claim: jest.fn().mockResolvedValue(false),
      heartbeat: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ReportCronLeaderService(
      buildConfig({ CRON_LEADER_ENABLED: 'true' }),
      lease,
      'discord',
    );

    await expect(service.shouldRunScheduledReportCron()).resolves.toBe(false);
  });

  it('heartbeats only when leader election is enabled', async () => {
    const lease: CronLeaderLeasePort = {
      claim: jest.fn().mockResolvedValue(true),
      heartbeat: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ReportCronLeaderService(
      buildConfig(),
      undefined,
      'messenger',
    );

    await service.heartbeat();
    expect(lease.heartbeat).not.toHaveBeenCalled();

    const enabled = new ReportCronLeaderService(
      buildConfig({ CRON_LEADER_ENABLED: 'true' }),
      lease,
      'messenger',
    );
    await enabled.heartbeat();
    expect(lease.heartbeat).toHaveBeenCalledWith('report:messenger', 'pod-a');
  });
});

describe('ReportCronLeaderService — per-platform leases (#510)', () => {
  /**
   * Faithful in-memory CronLeaderLeasePort: a Map keyed by lease name —
   * a claim wins when the name is free, owned by this instance, or expired.
   * Models what the fix changes (lease name selection), not Postgres.
   */
  class MemoryLeaseStore {
    private readonly holders = new Map<
      string,
      { instanceId: string; expiresAt: number }
    >();

    claim(name: string, instanceId: string): Promise<boolean> {
      const held = this.holders.get(name);
      if (
        held &&
        held.instanceId !== instanceId &&
        held.expiresAt > Date.now()
      ) {
        return Promise.resolve(false);
      }
      this.holders.set(name, {
        instanceId,
        expiresAt: Date.now() + 3 * 60 * 1000,
      });
      return Promise.resolve(true);
    }

    heartbeat(name: string, instanceId: string): Promise<void> {
      const held = this.holders.get(name);
      if (held?.instanceId === instanceId) {
        held.expiresAt = Date.now() + 3 * 60 * 1000;
      }
      return Promise.resolve();
    }
  }

  function platformService(
    leaseStore: MemoryLeaseStore,
    platform: 'messenger' | 'discord' | 'zalo',
    instanceId: string,
  ): ReportCronLeaderService {
    return new ReportCronLeaderService(
      buildConfig({ CRON_LEADER_ENABLED: 'true', INSTANCE_ID: instanceId }),
      leaseStore,
      platform,
    );
  }

  it('two platforms hold their leases concurrently — neither skips (#510 AC3)', async () => {
    const leaseStore = new MemoryLeaseStore();
    const messenger = platformService(leaseStore, 'messenger', 'pod-m1');
    const discord = platformService(leaseStore, 'discord', 'pod-d1');

    await expect(messenger.shouldRunScheduledReportCron()).resolves.toBe(true);
    await expect(discord.shouldRunScheduledReportCron()).resolves.toBe(true);
  });

  it('two pods of the same platform still contend on one lease', async () => {
    const leaseStore = new MemoryLeaseStore();
    const leader = platformService(leaseStore, 'discord', 'pod-d1');
    const follower = platformService(leaseStore, 'discord', 'pod-d2');

    await expect(leader.shouldRunScheduledReportCron()).resolves.toBe(true);
    await expect(follower.shouldRunScheduledReportCron()).resolves.toBe(false);
  });
});
