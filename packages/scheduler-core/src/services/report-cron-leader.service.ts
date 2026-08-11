import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CronLeaderLeasePort } from '../ports/cron-leader-lease.port';

@Injectable()
export class ReportCronLeaderService {
  private readonly logger = new Logger(ReportCronLeaderService.name);

  constructor(
    private readonly configService: ConfigService,
    leaseService?: CronLeaderLeasePort,
  ) {
    this.leaseService = leaseService ?? null;
  }

  private readonly leaseService: CronLeaderLeasePort | null;

  /** The cron leader (name) this instance participates in, or null when disabled. */
  getLeaderName(): string | null {
    const raw = this.configService
      .get<string>('CRON_LEADER_ENABLED')
      ?.trim()
      .toLowerCase();

    if (!raw || raw === 'false' || raw === '0' || raw === 'no') {
      return null;
    }
    return 'report';
  }

  /**
   * Whether this instance should run the scheduled report cron.
   *
   * - Leader election disabled (default): every instance runs; the advisory
   *   lock in `ReportCronLockService` serializes the batch — this already
   *   fails over automatically when a pod dies.
   * - Enabled with a lease store: instances race for a lease; the current
   *   holder heartbeats every minute, and any instance takes over once the
   *   lease expires — a dead leader no longer leaves the cron dead.
   */
  async shouldRunScheduledReportCron(): Promise<boolean> {
    const leaderName = this.getLeaderName();
    if (!leaderName) {
      return true;
    }

    if (!this.leaseService) {
      this.logger.warn(
        'CRON_LEADER_ENABLED=true but no lease store wired; running cron on all instances',
      );
      return true;
    }

    const instanceId = this.resolveInstanceId();
    return this.leaseService.claim(leaderName, instanceId);
  }

  /** Periodic lease refresh — call from a 1-minute cron so a live leader keeps the lease. */
  async heartbeat(): Promise<void> {
    const leaderName = this.getLeaderName();
    if (!leaderName || !this.leaseService) {
      return;
    }
    await this.leaseService.heartbeat(leaderName, this.resolveInstanceId());
  }

  resolveInstanceId(): string {
    return (
      this.configService.get<string>('INSTANCE_ID')?.trim() ||
      process.env.HOSTNAME?.trim() ||
      'default'
    );
  }
}
