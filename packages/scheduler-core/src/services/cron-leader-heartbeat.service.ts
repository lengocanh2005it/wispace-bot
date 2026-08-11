import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ReportCronLeaderService } from './report-cron-leader.service';

/**
 * Refreshes the cron-leader lease every minute so a live leader keeps it —
 * without this, the 08:00 cron leader would expire between daily runs and
 * ownership would flap to another pod.
 */
@Injectable()
export class CronLeaderHeartbeatService {
  private readonly logger = new Logger(CronLeaderHeartbeatService.name);

  constructor(
    private readonly reportCronLeaderService: ReportCronLeaderService,
  ) {}

  @Cron('*/1 * * * *', {
    name: 'cron-leader-heartbeat',
  })
  async handleHeartbeat(): Promise<void> {
    await this.reportCronLeaderService.heartbeat();
  }
}
