import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common/masking';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ZaloTokenService } from './zalo-token.service';
import { BotMetricsService } from '@wispace/bot-metrics';
import { withRootSpan } from '@wispace/bot-common/tracing';

const DEFAULT_REFRESH_CRON = '0 */45 * * * *';
const CRON_JOB_NAME = 'zalo-oa-token-refresh';
const EXPECTED_INTERVAL_MS = 45 * 60 * 1000;

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
    private readonly metrics?: BotMetricsService,
  ) {}

  onModuleInit(): void {
    const cronExpression =
      this.configService.get<string>('ZALO_TOKEN_REFRESH_CRON')?.trim() ||
      DEFAULT_REFRESH_CRON;

    const job = new CronJob(cronExpression, () => this.handleCron());
    let expectedIntervalMs = EXPECTED_INTERVAL_MS;
    try {
      const dates = job.nextDates(8);
      const intervals = dates
        .slice(1)
        .map((date, index) => date.toMillis() - dates[index].toMillis())
        .filter((interval) => interval > 0);
      const derivedIntervalMs =
        intervals.length > 0 ? Math.max(...intervals) : 0;
      if (derivedIntervalMs > 0) expectedIntervalMs = derivedIntervalMs;
    } catch {
      // Keep the documented default if the schedule cannot be sampled.
    }
    this.metrics?.registerCron?.(CRON_JOB_NAME, expectedIntervalMs);
    this.schedulerRegistry.addCronJob(CRON_JOB_NAME, job);
    job.start();
    this.logger.log(`Zalo OA token refresh cron started: ${cronExpression}`);
  }

  async handleCron(): Promise<void> {
    // A scheduled refresh with no human watching the request: a trace is the
    // only place the failure shape is visible once the single-use refresh
    // token is spent and a learner's linking flow is stuck (#1459).
    // The swallow stays as it was — a failing refresh must not escape into
    // the cron scheduler — but it happens outside the span, so the span still
    // records the failure.
    try {
      await withRootSpan('zalo-bot', 'zalo.oa_token_refresh', {}, async () => {
        await this.tokenService.refreshNow();
        this.metrics?.recordCronSuccess?.(CRON_JOB_NAME);
      });
    } catch (error) {
      this.logger.error(
        `Zalo OA token refresh cron failed: ${errorMessage(error)}`,
      );
    }
  }
}
