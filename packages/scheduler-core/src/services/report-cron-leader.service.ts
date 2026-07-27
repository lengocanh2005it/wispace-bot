import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ReportCronLeaderService {
  private readonly logger = new Logger(ReportCronLeaderService.name);

  constructor(private readonly configService: ConfigService) {}

  shouldRunScheduledReportCron(): boolean {
    const raw = this.configService
      .get<string>('CRON_LEADER_ENABLED')
      ?.trim()
      .toLowerCase();

    if (!raw || raw === 'false' || raw === '0' || raw === 'no') {
      return true;
    }

    const leaderId = this.configService
      .get<string>('CRON_LEADER_INSTANCE_ID')
      ?.trim();
    const instanceId = this.resolveInstanceId();

    if (!leaderId) {
      this.logger.warn(
        'CRON_LEADER_ENABLED=true but CRON_LEADER_INSTANCE_ID missing; running cron on all instances',
      );
      return true;
    }

    const isLeader = instanceId === leaderId;
    if (!isLeader) {
      this.logger.log(
        `Report cron skipped on non-leader instance instanceId=${instanceId} leaderId=${leaderId}`,
      );
    }

    return isLeader;
  }

  resolveInstanceId(): string {
    return (
      this.configService.get<string>('INSTANCE_ID')?.trim() ||
      process.env.HOSTNAME?.trim() ||
      'default'
    );
  }
}
