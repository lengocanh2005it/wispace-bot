import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  LearnerScheduledReportClaimEntity,
  MessageLogEntity,
} from '@messenger/infrastructure/database/entities';
import {
  startOfReportDay,
  todayReportDate,
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
    @Optional()
    @InjectRepository(LearnerScheduledReportClaimEntity)
    private readonly learnerClaimRepo?: Repository<LearnerScheduledReportClaimEntity>,
  ) {}

  async hasSentScheduledReportToday(
    externalUserId: string,
    userId?: number,
  ): Promise<boolean> {
    if (this.learnerClaimRepo) {
      const learnerClaim = await this.learnerClaimRepo.findOne({
        where: {
          ...(userId !== undefined
            ? { userId }
            : { platform: PLATFORM, externalUserId }),
          reportDate: todayReportDate(),
          reportType: 'scheduled',
          status: 'sent',
        },
      });
      if (learnerClaim) return true;
    }

    // Use the ICT report-day boundary rather than process-local midnight.
    const startOfDay = startOfReportDay();
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
      .getCount();

    return count > 0;
  }
}
