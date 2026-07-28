import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WispaceApiError } from '@wispace/wispace-client';
import type {
  UserGoalsRecord,
  TaskScoreAverageRecord,
} from '@wispace/wispace-client';
import { ZaloAccountLinkEntity } from '../../../../infrastructure/database/entities/zalo-account-link.entity';
import { ZaloWispaceGoalsService } from '../../../wispace/application/services/zalo-wispace-goals.service';
import { ZaloReportDeliveryService } from './zalo-report-delivery.service';

const CONCURRENCY = 3;

@Injectable()
export class ZaloReportCronService {
  private readonly logger = new Logger(ZaloReportCronService.name);

  constructor(
    @InjectRepository(ZaloAccountLinkEntity)
    private readonly linkRepo: Repository<ZaloAccountLinkEntity>,
    private readonly goalsService: ZaloWispaceGoalsService,
    private readonly deliveryService: ZaloReportDeliveryService,
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
    this.logger.log(`Sending daily reports to ${links.length} Zalo users`);

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < links.length; i += CONCURRENCY) {
      const batch = links.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((link) => this.sendReportForUser(link.externalUserId)),
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
    zaloUserId: string,
  ): Promise<'sent' | 'skipped' | 'error'> {
    try {
      const [goals, taskScores] = await Promise.all([
        this.goalsService.getUserGoals(zaloUserId),
        this.goalsService.getTaskScoreAverages(zaloUserId),
      ]);

      const report = formatReport(goals, taskScores);
      const delivered = await this.deliveryService.sendReport(
        zaloUserId,
        report,
      );
      if (delivered) {
        this.logger.log(`Report sent to Zalo user ${zaloUserId}`);
        return 'sent';
      }
      this.logger.warn(
        `Report skipped for Zalo user ${zaloUserId} (48h window)`,
      );
      return 'skipped';
    } catch (error) {
      if (
        error instanceof WispaceApiError &&
        (error.statusCode === 401 || error.statusCode === 403)
      ) {
        this.logger.warn(
          `Wispace access denied for Zalo user ${zaloUserId}: ${error.message}`,
        );
        return 'skipped';
      }
      this.logger.error(
        `Failed to send report to Zalo user ${zaloUserId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'error';
    }
  }
}

function formatReport(
  goals: UserGoalsRecord,
  taskScores: TaskScoreAverageRecord[],
): string {
  const lines: string[] = [
    '📊 Báo cáo học tập hôm nay',
    `🎯 Mục tiêu: Band ${goals.targetScore} | Ngày thi: ${goals.examDate}`,
    '',
  ];

  if (taskScores.length === 0) {
    lines.push('Chưa có dữ liệu điểm. Hãy nộp bài để xem tiến độ nhé!');
  } else {
    lines.push('📝 Điểm trung bình các kỹ năng:');
    for (const r of taskScores) {
      lines.push(
        `• ${r.task}: ${r.avgTotalScore.toFixed(1)} — đã làm ${r.totalTasks} bài`,
      );
    }
  }

  lines.push('', '💪 Cố gắng mỗi ngày bạn nhé!');
  return lines.join('\n');
}
