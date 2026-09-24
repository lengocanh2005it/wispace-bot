import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  LearnerScheduledReportClaimEntity,
  MessageLogEntity,
} from '@messenger/infrastructure/database/entities';
import {
  startOfNextReportDate,
  startOfReportDate,
} from '@wispace/scheduler-core/core';
import type { MessengerReportSentReaderPort } from '../../domain/repositories/messenger-report-sent-reader.port';

const PLATFORM = 'messenger' as const;

/**
 * Preserves Messenger's legacy sent-report guard while claim transitions use
 * the shared platform repository. The message-log fallback remains required
 * for rows written before the learner claim migration (#968).
 */
@Injectable()
export class MessengerReportSentReader implements MessengerReportSentReaderPort {
  constructor(
    @InjectRepository(MessageLogEntity)
    private readonly logRepo: Repository<MessageLogEntity>,
    private readonly configService: ConfigService,
    @Optional()
    @InjectRepository(LearnerScheduledReportClaimEntity)
    private readonly learnerClaimRepo?: Repository<LearnerScheduledReportClaimEntity>,
  ) {}

  async hasSentScheduledReportOn(
    externalUserId: string,
    reportDate: string,
    userId?: number,
  ): Promise<boolean> {
    if (this.learnerClaimRepo) {
      const learnerClaim = await this.learnerClaimRepo.findOne({
        where: {
          ...(userId !== undefined
            ? { userId }
            : { platform: PLATFORM, externalUserId }),
          reportDate,
          reportType: 'scheduled',
          status: 'sent',
        },
      });
      if (learnerClaim) return true;
    }

    const timezone =
      this.configService.get<string>('CHAT_USAGE_TIMEZONE')?.trim() ||
      'Asia/Ho_Chi_Minh';
    const startOfDay = startOfReportDate(reportDate, timezone);
    const endOfDay = startOfNextReportDate(reportDate, timezone);
    const count = await this.logRepo
      .createQueryBuilder('log')
      .where('log.platform = :platform', { platform: PLATFORM })
      .andWhere('log.external_user_id = :externalUserId', {
        externalUserId,
      })
      .andWhere('log.status = :status', { status: 'SENT' })
      .andWhere(
        `(log.message_type = :primaryType
          OR log.message_type LIKE :partType
          OR log.message_type LIKE :legacyPartType)`,
        {
          primaryType: 'SCHEDULED_LEARNING_REPORT',
          partType: 'SCHEDULED_LEARNING_REPORT_PART_%',
          legacyPartType: 'SCHEDULED_LEARNING_REPORT_PSID_FALLBACK%',
        },
      )
      .andWhere(
        userId !== undefined
          ? '(log.user_id = :userId OR log.user_id IS NULL)'
          : 'TRUE',
        userId !== undefined ? { userId } : {},
      )
      .andWhere('log.created_at >= :startOfDay', { startOfDay })
      .andWhere('log.created_at < :endOfDay', { endOfDay })
      .getCount();

    return count > 0;
  }
}
