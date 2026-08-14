import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import {
  REPORT_SEND_JOB_REPOSITORY,
  type ReportSendJobRepositoryPort,
} from '@wispace/scheduler-core';
import { DiscordReportOrchestrationService } from './discord-report-orchestration.service';
import { DiscordAccountLinkEntity } from '@discord/infrastructure/database/entities/discord-account-link.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ReportMapping } from '@wispace/scheduler-core';
import { todayReportDate } from '@wispace/scheduler-core';
import { subtractMs, minutesFromNow } from '@wispace/date-utils';

const PLATFORM = 'discord' as const;

@Injectable()
export class DiscordReportRetryDispatchService {
  private readonly logger = new Logger(DiscordReportRetryDispatchService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(REPORT_SEND_JOB_REPOSITORY)
    private readonly jobRepository: ReportSendJobRepositoryPort,
    private readonly orchestrationService: DiscordReportOrchestrationService,
    @InjectRepository(DiscordAccountLinkEntity)
    private readonly accountLinkRepo: Repository<DiscordAccountLinkEntity>,
  ) {}

  @Cron('*/15 * * * *', {
    name: 'discord-report-retry-dispatch',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleRetryDispatch(): Promise<void> {
    await this.dispatchDueReportRetries();
  }

  async dispatchDueReportRetries() {
    const now = new Date();
    const resetStuck = await this.jobRepository.resetStuckProcessingJobs(
      subtractMs(now, 10 * 60 * 1000),
    );

    const dueJobs = await this.jobRepository.findDueJobs(now);
    let sent = 0;
    let retryQueued = 0;
    let failed = 0;
    const failures: Array<{ externalUserId: string; error: string }> = [];

    for (const job of dueJobs) {
      const claimed = await this.jobRepository.claimJob(job.id, this.leaseMs);
      if (!claimed) continue;

      const leaseToken = claimed.leaseToken ?? '';

      const link = await this.accountLinkRepo.findOne({
        where: {
          platform: PLATFORM,
          externalUserId: job.externalUserId,
        },
      });

      if (!link) {
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
        externalUserId: link.externalUserId,
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
      } else if (result.failures.length > 0) {
        const error = result.failures[0].error;
        const nextRetryAt = minutesFromNow(15);
        await this.jobRepository.markFailed({
          jobId: job.id,
          leaseToken,
          errorMessage: error,
          retryCount: job.retryCount + 1,
          nextRetryAt,
          terminal: job.retryCount + 1 >= job.maxRetries,
        });
        if (job.retryCount + 1 >= job.maxRetries) {
          failed += 1;
          failures.push({ externalUserId: job.externalUserId, error });
        } else {
          retryQueued += 1;
        }
      }
    }

    if (dueJobs.length > 0 || resetStuck > 0) {
      this.logger.log(
        `Discord report retry dispatch: sent=${sent} retryQueued=${retryQueued} failed=${failed} resetStuck=${resetStuck}`,
      );
    }

    return { sent, retryQueued, failed, failures };
  }

  private get leaseMs(): number {
    const raw = this.configService.get<string>('REPORT_SEND_LEASE_MS')?.trim();
    if (!raw) return 600_000;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 600_000;
  }
}
