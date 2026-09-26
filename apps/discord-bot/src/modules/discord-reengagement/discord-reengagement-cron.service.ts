import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { sleep } from '@wispace/bot-common/utils';
import {
  ADVISORY_LOCKS,
  PgAdvisoryLockService,
} from '@wispace/bot-common/locks';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { BotMetricsService } from '@wispace/bot-metrics';
import {
  NOTIFICATION_PREFERENCE,
  type NotificationPreferencePort,
} from '@wispace/contracts';
import { ReengagementApiClient } from '@wispace/wispace-client/core';
import type { ReengagementCandidate } from '@wispace/wispace-client/core';
import { DiscordReengagementService } from './discord-reengagement.service';

const CRON_NAME = 'discord-reengagement-batch';
const DEFAULT_CRON = '0 9 * * *';
const DEFAULT_TIMEZONE = 'Asia/Ho_Chi_Minh';
const DEFAULT_DAYS = 11;
const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_PER_BATCH = 100;
const DEFAULT_SEND_GAP_MS = 500;
/** Heartbeat expected cadence — the batch runs at most once per day. */
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ReengagementBatchSummary {
  fetched: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * Daily D11 scan + batch dispatch (#854). The backend suppression rule is the
 * dedupe authority — this worker keeps no local sent-state. The #595 dormancy
 * gate never applies here (every candidate is dormant by definition); the
 * #596 consent filter (report opt-in) does.
 */
@Injectable()
export class DiscordReengagementCronService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DiscordReengagementCronService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly reengagementClient: ReengagementApiClient,
    private readonly orchestrator: DiscordReengagementService,
    @Inject(NOTIFICATION_PREFERENCE)
    private readonly preferences: NotificationPreferencePort,
    private readonly pgLock: PgAdvisoryLockService,
    @Optional()
    @Inject(BotMetricsService)
    private readonly metrics?: BotMetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.isEnabled()) return;
    const expression =
      this.configService.get<string>('REENGAGEMENT_CRON')?.trim() ||
      DEFAULT_CRON;
    const timezone =
      this.configService.get<string>('REENGAGEMENT_TIMEZONE')?.trim() ||
      DEFAULT_TIMEZONE;
    const job = new CronJob(
      expression,
      () => {
        // Fire-and-forget tick — a scan failure must never become an
        // unhandled rejection that crashes the process.
        this.handleDailyBatch().catch((error: unknown) => {
          this.logger.error(
            `Re-engagement batch tick failed: ${errorMessage(error)}`,
          );
          this.metrics?.incReengagementSend('failed');
        });
      },
      null,
      false,
      timezone,
    );
    this.schedulerRegistry.addCronJob(CRON_NAME, job);
    job.start();
    // Staleness heartbeat — feeds the existing CronExecutionStale alert so a
    // silently dead batch cron is observable after prod enablement (#855).
    this.metrics?.registerCron(CRON_NAME, DAILY_INTERVAL_MS);
    this.logger.log(
      `Re-engagement batch cron registered (${expression}, ${timezone})`,
    );
  }

  onModuleDestroy(): void {
    try {
      this.schedulerRegistry.deleteCronJob(CRON_NAME);
    } catch {
      // not registered (feature disabled) — nothing to clean up
    }
  }

  async handleDailyBatch(): Promise<ReengagementBatchSummary | undefined> {
    if (!this.isEnabled()) return undefined;
    const result = await this.pgLock.withLock(
      ADVISORY_LOCKS.DISCORD_REENGAGEMENT,
      () => this.runBatch(),
    );
    if (result === null) {
      this.logger.warn(
        'Re-engagement batch skipped — another holder owns the lock',
      );
      return undefined;
    }
    return result;
  }

  private isEnabled(): boolean {
    return this.configService.get<string>('REENGAGEMENT_ENABLED') === 'true';
  }

  private readNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key)?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  private async runBatch(): Promise<ReengagementBatchSummary> {
    const startedAt = Date.now();
    const dryRun =
      this.configService.get<string>('REENGAGEMENT_DRY_RUN') === 'true';
    const days = this.readNumber('REENGAGEMENT_DAYS', DEFAULT_DAYS);
    const limit = this.readNumber('REENGAGEMENT_LIMIT', DEFAULT_LIMIT);
    const maxPerBatch = this.readNumber(
      'REENGAGEMENT_MAX_PER_BATCH',
      DEFAULT_MAX_PER_BATCH,
    );
    const gapMs = this.readNumber(
      'REENGAGEMENT_SEND_GAP_MS',
      DEFAULT_SEND_GAP_MS,
    );

    const scan = await this.reengagementClient.getCandidates({
      platform: 'discord',
      days,
      limit,
    });
    const batch = scan.candidates.slice(0, maxPerBatch);
    if (scan.totalCandidates > batch.length) {
      this.logger.warn(
        `Re-engagement scan returned ${scan.totalCandidates} candidates — processing only ${batch.length} this batch (ceiling ${maxPerBatch}, page ${limit})`,
      );
    }
    this.metrics?.incReengagementSend('fetched', batch.length);
    this.logger.log(
      `Re-engagement batch: ${batch.length}/${scan.totalCandidates} candidates (days=${days}, dryRun=${dryRun})`,
    );

    const optedIn = await this.preferences.findReportOptedInUserIds(
      batch.map((candidate) => Number(candidate.userId)),
    );
    const eligible = batch.filter((candidate) =>
      optedIn.has(Number(candidate.userId)),
    );
    const skipped = batch.length - eligible.length;
    if (skipped > 0) {
      this.metrics?.incReengagementSend('skipped', skipped);
    }

    const summary: ReengagementBatchSummary = {
      fetched: batch.length,
      sent: 0,
      failed: 0,
      skipped,
    };

    for (let index = 0; index < eligible.length; index++) {
      const candidate = eligible[index] as ReengagementCandidate;
      if (dryRun) {
        this.logger.log(
          `[DRY-RUN] would send re-engagement to userId=${maskExternalId(String(candidate.userId))} (daysInactive=${candidate.daysInactive}, variant=${candidate.variant})`,
        );
      } else {
        try {
          const outcome = await this.orchestrator.runOnce(
            Number(candidate.userId),
            { daysInactive: candidate.daysInactive },
          );
          if (outcome.outcome === 'sent' || outcome.outcome === 'ambiguous') {
            // mark_sent_error lands here too — the DM went out; the outcome
            // stays truthful in the counter and the response, and the batch
            // counts it as processed rather than failed.
            summary.sent += 1;
          } else {
            summary.failed += 1;
          }
        } catch (error) {
          // A thrown mapping/DB read on one candidate must not abort the
          // remaining sends (#854 AC) — count it and keep going.
          this.logger.warn(
            `Re-engagement send crashed for userId=${maskExternalId(String(candidate.userId))}: ${errorMessage(error)}`,
          );
          summary.failed += 1;
        }
      }
      if (gapMs > 0 && index < eligible.length - 1) {
        await sleep(gapMs);
      }
    }

    // A completed batch (dry-run included, empty included) is a successful
    // cron execution for the staleness heartbeat (#855); lock contention
    // never reaches this line, so it records nothing.
    this.metrics?.recordCronSuccess(CRON_NAME);
    this.metrics?.setReengagementBatchDuration((Date.now() - startedAt) / 1000);
    this.logger.log(
      `Re-engagement batch done: fetched=${summary.fetched} sent=${summary.sent} failed=${summary.failed} skipped=${summary.skipped}${dryRun ? ' (dry-run)' : ''} candidates=[${eligible.map((c) => maskExternalId(String(c.userId))).join(', ')}]`,
    );
    return summary;
  }
}
