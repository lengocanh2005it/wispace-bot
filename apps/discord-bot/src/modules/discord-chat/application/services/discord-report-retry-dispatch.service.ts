import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import {
  REPORT_SEND_JOB_REPOSITORY,
  ReportCronLeaderService,
  type ReportSendJobRepositoryPort,
} from '@wispace/scheduler-core';
import { DiscordReportOrchestrationService } from './discord-report-orchestration.service';
import {
  DISCORD_REPORT_ACCOUNT_READER,
  type DiscordReportAccountPageReaderPort,
} from '../../domain/ports/discord-report-account-reader.port';
import type { ReportMapping } from '@wispace/scheduler-core';
import { todayReportDate } from '@wispace/scheduler-core';
import { subMilliseconds, addMinutes } from 'date-fns';
import { BotMetricsService } from '@wispace/bot-metrics';
import {
  PgAdvisoryLockService,
  ADVISORY_LOCKS,
} from '@wispace/bot-common/locks';

const PLATFORM = 'discord' as const;
const REPORT_RETRY_EXPECTED_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_LEASE_MS = 600_000;
const RETRY_BACKOFF_MINUTES = 15;
const DEFERRED_ERROR = 'Report generation deferred (upstream retryable)';

@Injectable()
export class DiscordReportRetryDispatchService {
  private readonly logger = new Logger(DiscordReportRetryDispatchService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(REPORT_SEND_JOB_REPOSITORY)
    private readonly jobRepository: ReportSendJobRepositoryPort,
    private readonly orchestrationService: DiscordReportOrchestrationService,
    @Inject(DISCORD_REPORT_ACCOUNT_READER)
    private readonly accountLinkReader: DiscordReportAccountPageReaderPort,
    private readonly reportCronLeaderService: ReportCronLeaderService,
    private readonly pgLock: PgAdvisoryLockService,
    @Optional() private readonly metrics?: BotMetricsService,
  ) {
    this.metrics?.registerCron?.(
      'discord-report-retry-dispatch',
      REPORT_RETRY_EXPECTED_INTERVAL_MS,
    );
  }

  @Cron('*/15 * * * *', {
    name: 'discord-report-retry-dispatch',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleRetryDispatch(): Promise<void> {
    if (!(await this.reportCronLeaderService.shouldRunScheduledReportCron())) {
      return;
    }

    const result = await this.pgLock.withLock(
      ADVISORY_LOCKS.DISCORD_REPORT_RETRY_DISPATCH,
      () => this.dispatchDueReportRetries(),
    );
    if (result === null) {
      this.logger.debug(
        'discord-report-retry-dispatch skipped — lock held by another pod',
      );
      return;
    }
    this.metrics?.recordCronSuccess?.('discord-report-retry-dispatch');
  }

  async dispatchDueReportRetries() {
    const now = new Date();
    // Invariant (#521): the stuck threshold must exceed the claim lease
    // (2x) so a slow send is never reclaimed while its owner still holds a
    // valid lease — the late markSent can then never hit a token mismatch.
    const resetStuck = await this.jobRepository.resetStuckProcessingJobs(
      subMilliseconds(now, 2 * this.leaseMs),
    );

    const dueJobs = await this.jobRepository.findDueJobs(now);
    let sent = 0;
    let retryQueued = 0;
    let failed = 0;
    let windowClosed = 0;
    const failures: Array<{ externalUserId: string; error: string }> = [];

    for (const job of dueJobs) {
      const claimed = await this.jobRepository.claimJob(job.id, this.leaseMs);
      if (!claimed) continue;

      const leaseToken = claimed.leaseToken ?? '';

      const link = await this.accountLinkReader.findLinkStateByExternalUserId(
        job.externalUserId,
      );

      if (!link || (link.linkState && link.linkState !== 'active')) {
        if (link?.linkState === 'temporarily-unknown') {
          const nextRetryCount = job.retryCount + 1;
          await this.jobRepository.markFailed({
            jobId: job.id,
            leaseToken,
            errorMessage: 'WISPACE link status temporarily unknown',
            retryCount: nextRetryCount,
            nextRetryAt: addMinutes(new Date(), RETRY_BACKOFF_MINUTES),
            terminal: nextRetryCount >= job.maxRetries,
          });
          if (nextRetryCount < job.maxRetries) retryQueued += 1;
          else failed += 1;
          continue;
        }
        await this.jobRepository.markFailed({
          jobId: job.id,
          leaseToken,
          errorMessage: 'No active Discord account link',
          retryCount: job.retryCount + 1,
          terminal: true,
        });
        failed += 1;
        continue;
      }

      const mapping: ReportMapping = {
        id: link.id,
        platform: PLATFORM,
        externalUserId: job.externalUserId,
        userId: link.userId ?? undefined,
        notificationCadence: 'daily',
        status: 'ACTIVE',
      };

      const reportDate = todayReportDate();
      const result = await this.orchestrationService.claimAndSend(mapping, {
        reportDate,
        skipAlreadySentToday: true,
        examDateForOutbox: job.examDate,
      });

      if (result.sent > 0) {
        await this.jobRepository.markSent(job.id, leaseToken);
        sent += 1;
      } else if (result.skipped > 0) {
        // Report already delivered today by another path — outbox job is done.
        await this.jobRepository.markSent(job.id, leaseToken);
        sent += 1;
      } else if (result.claimSkipped > 0) {
        // Another worker holds a live claim for this learner's report —
        // requeue without consuming a retry; it will resolve on a later tick.
        await this.jobRepository.markFailed({
          jobId: job.id,
          leaseToken,
          errorMessage: 'Report claim exists for today',
          retryCount: job.retryCount,
          nextRetryAt: addMinutes(new Date(), RETRY_BACKOFF_MINUTES),
          terminal: false,
        });
        retryQueued += 1;
      } else if (result.deferred > 0) {
        // Upstream deferred (retryable generation/delivery) — park the job
        // with a future next_retry_at instead of leaving it processing.
        const nextRetryCount = job.retryCount + 1;
        const terminal = nextRetryCount >= job.maxRetries;
        await this.jobRepository.markFailed({
          jobId: job.id,
          leaseToken,
          errorMessage: DEFERRED_ERROR,
          retryCount: nextRetryCount,
          nextRetryAt: terminal
            ? undefined
            : addMinutes(new Date(), RETRY_BACKOFF_MINUTES),
          terminal,
        });
        if (terminal) {
          failed += 1;
          failures.push({
            externalUserId: job.externalUserId,
            error: DEFERRED_ERROR,
          });
        } else {
          retryQueued += 1;
        }
      } else if (result.windowClosed > 0) {
        // Exam window closed — the report would be noise; expire the job.
        await this.jobRepository.markFailed({
          jobId: job.id,
          leaseToken,
          errorMessage: 'Exam window closed',
          retryCount: job.maxRetries,
          terminal: true,
        });
        windowClosed += 1;
      } else if (result.failures.length > 0) {
        const error = result.failures[0].error;
        const rateLimited = error === 'outbound_rate_limited';
        const nextRetryAt = rateLimited
          ? undefined
          : addMinutes(new Date(), 15);
        const nextRetryCount = job.retryCount + 1;
        await this.jobRepository.markFailed({
          jobId: job.id,
          leaseToken,
          errorMessage: error,
          retryCount: nextRetryCount,
          nextRetryAt,
          terminal: rateLimited || nextRetryCount >= job.maxRetries,
        });
        if (rateLimited || nextRetryCount >= job.maxRetries) {
          failed += 1;
          failures.push({ externalUserId: job.externalUserId, error });
        } else {
          retryQueued += 1;
        }
      }
    }

    if (dueJobs.length > 0 || resetStuck > 0) {
      this.logger.log(
        `Discord report retry dispatch: sent=${sent} retryQueued=${retryQueued} failed=${failed} windowClosed=${windowClosed} resetStuck=${resetStuck}`,
      );
    }

    return { sent, retryQueued, failed, windowClosed, failures };
  }

  private get leaseMs(): number {
    const raw = this.configService.get<string>('REPORT_SEND_LEASE_MS')?.trim();
    if (!raw) return DEFAULT_LEASE_MS;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_LEASE_MS;
  }
}
