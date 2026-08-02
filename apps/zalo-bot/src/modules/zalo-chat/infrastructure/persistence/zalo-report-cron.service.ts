import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WispaceApiError } from '@wispace/wispace-client';
import { ZaloAccountLinkEntity } from '@zalo/infrastructure/database/entities/zalo-account-link.entity';
import { ScheduledReportClaimEntity } from '@wispace/database';
import { todayReportDate } from '@wispace/scheduler-core';
import { ZaloReportDeliveryService } from '../../application/services/zalo-report-delivery.service';
import { ZaloStudentReportService } from '../../application/services/zalo-student-report.service';

const CONCURRENCY = 3;

@Injectable()
export class ZaloReportCronService {
  private readonly logger = new Logger(ZaloReportCronService.name);

  constructor(
    @InjectRepository(ZaloAccountLinkEntity)
    private readonly linkRepo: Repository<ZaloAccountLinkEntity>,
    @InjectRepository(ScheduledReportClaimEntity)
    private readonly claimRepo: Repository<ScheduledReportClaimEntity>,
    private readonly deliveryService: ZaloReportDeliveryService,
    private readonly reportService: ZaloStudentReportService,
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

    for (let i = 0; i < links.length; i += CONCURRENCY) {
      const batch = links.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((link) => this.sendReportForUser(link, reportDate)),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          if (r.value === 'sent') sent++;
          else if (r.value === 'skipped') skipped++;
          else failed++;
        } else {
          failed++;
          errors.push(
            r.reason instanceof Error ? r.reason.message : String(r.reason),
          );
        }
      }
    }

    this.logger.log(
      `Daily report done: sent=${sent}, skipped(48h)=${skipped}, failed=${failed}${errors.length > 0 ? ', errors=' + errors.join('; ') : ''}`,
    );
  }

  private async sendReportForUser(
    link: ZaloAccountLinkEntity,
    reportDate: string,
  ): Promise<'sent' | 'skipped' | 'error'> {
    if (link.userId) {
      const alreadySent = await this.claimRepo.count({
        where: { userId: link.userId, reportDate, status: 'sent' },
      });
      if (alreadySent > 0) {
        this.logger.log(
          `Report already sent on another platform for userId=${link.userId}, skipping Zalo`,
        );
        return 'skipped';
      }
    }

    try {
      const report = await this.reportService.generateReport(
        link.externalUserId,
      );
      const delivered = await this.deliveryService.sendReport(
        link.externalUserId,
        report,
      );
      if (delivered) {
        if (link.userId) {
          await this.claimRepo
            .insert({
              platform: 'zalo',
              externalUserId: link.externalUserId,
              userId: link.userId,
              reportDate,
              status: 'sent',
            })
            .catch(() => {});
        }
        this.logger.log(`Report sent to Zalo user ${link.externalUserId}`);
        return 'sent';
      }
      this.logger.warn(
        `Report skipped for Zalo user ${link.externalUserId} (48h window)`,
      );
      return 'skipped';
    } catch (error) {
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
