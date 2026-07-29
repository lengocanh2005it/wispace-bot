import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import {
  ReportCronLeaderService,
  ReportCronLockService,
  ReportScheduleService,
  todayReportDate,
} from '@wispace/scheduler-core';
import { DiscordReportOrchestrationService } from './discord-report-orchestration.service';
import { DiscordAccountLinkEntity } from '@discord/infrastructure/database/entities/discord-account-link.entity';
import { ScheduledReportClaimEntity } from '@discord/infrastructure/database/entities/scheduled-report-claim.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ReportMapping } from '@wispace/scheduler-core';

const PLATFORM = 'discord' as const;
const DEFAULT_SEND_CONCURRENCY = 3;

@Injectable()
export class DiscordReportCronService {
  private readonly logger = new Logger(DiscordReportCronService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly reportCronLeaderService: ReportCronLeaderService,
    private readonly reportCronLockService: ReportCronLockService,
    private readonly reportScheduleService: ReportScheduleService,
    private readonly orchestrationService: DiscordReportOrchestrationService,
    @InjectRepository(DiscordAccountLinkEntity)
    private readonly accountLinkRepo: Repository<DiscordAccountLinkEntity>,
    @InjectRepository(ScheduledReportClaimEntity)
    private readonly claimRepo: Repository<ScheduledReportClaimEntity>,
  ) {}

  @Cron('0 8 * * *', {
    name: 'discord-exam-reminder-report',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleDailyReportCron(): Promise<void> {
    if (!this.reportCronLeaderService.shouldRunScheduledReportCron()) {
      return;
    }

    const acquired = await this.reportCronLockService.tryAcquireDailyLock();
    if (!acquired) return;

    try {
      await this.sendScheduledReports();
    } finally {
      await this.reportCronLockService.releaseDailyLock();
    }
  }

  async sendScheduledReports(
    opts: { forceSend?: boolean; externalUserId?: string } = {},
  ) {
    const reportDate = todayReportDate();
    const concurrency = Number(
      this.configService.get<string>('DISCORD_REPORT_SEND_CONCURRENCY') ??
        DEFAULT_SEND_CONCURRENCY,
    );

    const links = await this.accountLinkRepo.find({
      where: { platform: PLATFORM },
    });

    let sent = 0;
    let skipped = 0;
    let claimSkipped = 0;
    let failed = 0;
    const failures: Array<{ externalUserId: string; error: string }> = [];

    for (let i = 0; i < links.length; i += concurrency) {
      const batch = links.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async (link) => {
          const mapping: ReportMapping = {
            id: link.id,
            platform: PLATFORM,
            externalUserId: link.externalUserId,
            userId: link.userId ?? undefined,
            notificationCadence: 'daily',
            status: 'ACTIVE',
          };
          if (await this.isAlreadySentToday(link.userId, reportDate)) {
            return {
              sent: 0,
              skipped: 0,
              claimSkipped: 1,
              deferred: 0,
              windowClosed: 0,
              retryQueued: 0,
              failures: [],
            };
          }
          return this.orchestrationService.claimAndSend(mapping, {
            reportDate,
            skipAlreadySentToday: !opts.forceSend,
          });
        }),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          sent += result.value.sent;
          skipped += result.value.skipped;
          claimSkipped += result.value.claimSkipped;
          failures.push(...result.value.failures);
          failed += result.value.failures.length;
        } else {
          failed += 1;
          const reason = result.reason as Error | undefined;
          failures.push({
            externalUserId: 'unknown',
            error: reason?.message ?? String(reason),
          });
        }
      }
    }

    this.logger.log(
      `Discord report cron: total=${links.length} sent=${sent} skipped=${skipped} claimSkipped=${claimSkipped} failed=${failed}`,
    );

    return {
      total: links.length,
      sent,
      skipped,
      claimSkipped,
      failed,
      failures,
    };
  }

  private async isAlreadySentToday(
    userId: number | undefined | null,
    reportDate: string,
  ): Promise<boolean> {
    if (!userId) return false;
    const count = await this.claimRepo.count({
      where: { userId, reportDate, status: 'sent' },
    });
    return count > 0;
  }
}
