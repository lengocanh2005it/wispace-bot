import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { subtractMs } from '@wispace/date-utils';
import { MessengerLinkVerifyRecordEntity } from '@messenger/infrastructure/database/entities/messenger-link-verify-record.entity';
import type {
  MessengerLinkVerifyRecordRepositoryPort,
  StaleVerifyRecord,
} from '../../domain/ports/messenger-link-verify-record.repository.port';

/**
 * TypeORM implementation of the verify-intent outbox port (#384).
 * The link flow records the verify BEFORE committing the mapping, so a
 * crash between WISPACE token verify and the local upsert leaves a
 * recoverable intent — `MessengerLinkReconcileCronService` re-commits the
 * mapping from here.
 */
@Injectable()
export class TypeormMessengerLinkVerifyRecordRepository implements MessengerLinkVerifyRecordRepositoryPort {
  constructor(
    @InjectRepository(MessengerLinkVerifyRecordEntity)
    private readonly repo: Repository<MessengerLinkVerifyRecordEntity>,
  ) {}

  /** Upsert the verify intent (idempotent — a retried callback overwrites). */
  async recordVerify(psid: string, userId: number): Promise<void> {
    await this.repo.upsert({ psid, userId, verifiedAt: new Date() }, ['psid']);
  }

  /** Delete the intent once the mapping is committed (fire-and-forget safe). */
  async consumeRecord(psid: string): Promise<void> {
    await this.repo.delete({ psid });
  }

  /** Verify intents older than `olderThanMs` — candidates for reconciliation. */
  async listStaleRecords(olderThanMs: number): Promise<StaleVerifyRecord[]> {
    // ponytail: bounded batch — matches Discord's take:100, drains across ticks
    const rows = await this.repo
      .createQueryBuilder('record')
      .where('record.verified_at < :cutoff', {
        cutoff: subtractMs(new Date(), olderThanMs),
      })
      .orderBy('record.verified_at', 'ASC')
      .take(100)
      .getMany();

    return rows.map((row) => ({
      psid: row.psid,
      userId: row.userId,
      verifiedAt: row.verifiedAt,
    }));
  }
}
