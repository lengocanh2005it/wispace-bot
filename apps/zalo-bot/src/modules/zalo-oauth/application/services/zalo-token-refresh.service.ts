import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common/masking';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ZaloTokenService } from './zalo-token.service';

const DEFAULT_REFRESH_CRON = '0 */45 * * * *';
const CRON_JOB_NAME = 'zalo-oa-token-refresh';

/**
 * Refreshes the OA access_token proactively (default every 45 min — access_token
 * lifetime is 1h, so this comfortably beats the 10-min buffer in
 * ZaloTokenService.getValidAccessToken) — see spec §5.1.
 */
@Injectable()
export class ZaloTokenRefreshService implements OnModuleInit {
  private readonly logger = new Logger(ZaloTokenRefreshService.name);

  constructor(
    private readonly tokenService: ZaloTokenService,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const cronExpression =
      this.configService.get<string>('ZALO_TOKEN_REFRESH_CRON')?.trim() ||
      DEFAULT_REFRESH_CRON;

    const job = new CronJob(cronExpression, () => this.handleCron());
    this.schedulerRegistry.addCronJob(CRON_JOB_NAME, job);
    job.start();
    this.logger.log(`Zalo OA token refresh cron started: ${cronExpression}`);
  }

  async handleCron(): Promise<void> {
    try {
      await this.tokenService.refreshNow();
    } catch (error) {
      this.logger.error(
        `Zalo OA token refresh cron failed: ${errorMessage(error)}`,
      );
    }
  }
}
