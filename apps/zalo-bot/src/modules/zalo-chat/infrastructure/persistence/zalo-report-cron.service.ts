import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WispaceApiError } from '@wispace/wispace-client';
import { PlatformStudentReportService } from '@wispace/student-report';
import type { ReportClaimRepositoryPort } from '@wispace/scheduler-core';
import {
  REPORT_CLAIM_REPOSITORY,
  runBatched,
  todayReportDate,
} from '@wispace/scheduler-core';
import { ZaloAccountLinkEntity } from '@zalo/infrastructure/database/entities/zalo-account-link.entity';
import {
  ZaloOutboundService,
  ZaloSendError,
} from '../../application/services/zalo-outbound.service';

const CONCURRENCY = 3;

@Injectable()
export class ZaloReportCronService {
  private readonly logger = new Logger(ZaloReportCronService.name);

  constructor(
    @InjectRepository(ZaloAccountLinkEntity)
    private readonly linkRepo: Repository<ZaloAccountLinkEntity>,
    @Inject(REPORT_CLAIM_REPOSITORY)
    private readonly claimRepo: ReportClaimRepositoryPort,
    private readonly outbound: ZaloOutboundService,
    private readonly reportService: PlatformStudentReportService,
  ) {}

  @Cron('0 8 * * *', {
    name: 'zalo-report-cron',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async sendDailyReports(): Promise<void> {
    const links = await this.linkRepo.find({ where: { platform: 'zalo' } });
    if (links.length === 0) {
      this.logger.log('No linked accounts found for daily report');
      return;
    }
    const reportDate = todayReportDate();
    this.logger.log(
      `Sending daily reports to ${links.length} Zalo users (reportDate=${reportDate})`,
    );

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    const results = await runBatched(links, CONCURRENCY, (link) =>
      this.sendReportForUser(link, reportDate),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const v = r.value as 'sent' | 'skipped' | 'error';
        if (v === 'sent') sent++;
        else if (v === 'skipped') skipped++;
        else failed++;
      } else {
        failed++;
        errors.push(
          r.reason instanceof Error ? r.reason.message : String(r.reason),
        );
      }
    }

    this.logger.log(
      `Daily report done: sent=${sent}, skipped(already-sent/claimed/48h)=${skipped}, failed=${failed}${errors.length > 0 ? ', errors=' + errors.join('; ') : ''}`,
    );
  }

  private async sendReportForUser(
    link: ZaloAccountLinkEntity,
    reportDate: string,
  ): Promise<'sent' | 'skipped' | 'error'> {
    if (link.userId) {
      const alreadySent = await this.claimRepo.hasAnyPlatformSentReportToday(
        link.userId,
        reportDate,
      );
      if (alreadySent) {
        this.logger.log(
          `Report already sent on another platform for userId=${link.userId}, skipping Zalo`,
        );
        return 'skipped';
      }
      const claimed = await this.claimRepo.tryClaimScheduledReport({
        externalUserId: link.externalUserId,
        userId: link.userId,
        reportDate,
      });
      if (!claimed) {
        this.logger.log(
          `Report already claimed by another instance for Zalo user ${link.externalUserId}, skipping`,
        );
        return 'skipped';
      }
    }

    try {
      const report = await this.reportService.generateReport(
        link.externalUserId,
      );
      await this.outbound.sendText(link.externalUserId, report);
      if (link.userId) {
        await this.claimRepo.markScheduledReportClaimSent({
          externalUserId: link.externalUserId,
          reportDate,
        });
      }
      this.logger.log(`Report sent to Zalo user ${link.externalUserId}`);
      return 'sent';
    } catch (error) {
      if (link.userId) {
        await this.claimRepo
          .releaseScheduledReportClaim({
            externalUserId: link.externalUserId,
            reportDate,
          })
          .catch((releaseError) => {
            this.logger.error(
              `Failed to release report claim for Zalo user ${link.externalUserId}: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
            );
          });
      }
      if (error instanceof ZaloSendError && error.is48hWindowError()) {
        this.logger.warn(
          `48h window closed for Zalo user ${link.externalUserId}, report not delivered`,
        );
        return 'skipped';
      }
      if (
        error instanceof WispaceApiError &&
        (error.statusCode === 401 || error.statusCode === 403)
      ) {
        this.logger.warn(
          `Wispace access denied for Zalo user ${link.externalUserId}: ${error.message}`,
        );
        return 'skipped';
      }
      this.logger.error(
        `Failed to send report to Zalo user ${link.externalUserId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'error';
    }
  }
}
