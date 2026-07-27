import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { OpsHealthRepositoryPort } from '@wispace/ops-health';
import { ReportSendJobEntity } from '../../../../infrastructure/database/entities/report-send-job.entity';
import { DiscordMessageLogEntity } from '../../../../infrastructure/database/entities/discord-message-log.entity';

const PLATFORM = 'discord' as const;

@Injectable()
export class DiscordOpsHealthRepository implements OpsHealthRepositoryPort {
  constructor(
    @InjectRepository(ReportSendJobEntity)
    private readonly reportJobRepo: Repository<ReportSendJobEntity>,
    @InjectRepository(DiscordMessageLogEntity)
    private readonly messageLogRepo: Repository<DiscordMessageLogEntity>,
  ) {}

  async getChatQuotaSummary(): Promise<Record<string, unknown>> {
    const denyCount = await this.messageLogRepo
      .createQueryBuilder('log')
      .where('log.platform = :platform', { platform: PLATFORM })
      .andWhere('log.status = :status', { status: 'FAILED' })
      .andWhere('log.created_at >= :since', {
        since: new Date(Date.now() - 24 * 60 * 60 * 1000),
      })
      .getCount();

    return {
      denyLogs24h: denyCount,
      stuckReserved: 0,
      usersAtDailyLimit: 0,
    };
  }

  async getStudyReminderSummary(): Promise<Record<string, unknown>> {
    const counts = await this.reportJobRepo
      .createQueryBuilder('job')
      .where('job.platform = :platform', { platform: PLATFORM })
      .select('job.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('job.status')
      .getRawMany<{ status: string; count: string }>();

    const countsByStatus: Record<string, number> = {};
    for (const row of counts) {
      countsByStatus[row.status] = parseInt(row.count, 10);
    }

    return {
      countsByStatus,
      terminalFailedSince: 0,
      stuckProcessing: 0,
    };
  }

  getLlmSafetyWarningsCount(): Promise<number> {
    // Discord doesn't have a dedicated safety events table yet
    return Promise.resolve(0);
  }
}
