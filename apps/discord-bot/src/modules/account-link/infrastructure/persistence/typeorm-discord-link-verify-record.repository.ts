import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { subMilliseconds } from 'date-fns';
import { DiscordLinkVerifyRecordEntity } from '@discord/infrastructure/database/entities/discord-link-verify-record.entity';
import type {
  DiscordLinkVerifyRecordRepositoryPort,
  PendingVerifyRecord,
  StaleVerifyRecord,
} from '../../domain/ports/discord-link-verify-record.repository.port';

/**
 * TypeORM implementation of the verify-intent outbox port (#137 item 1).
 * The OAuth callback records the verify BEFORE committing the mapping, so a
 * crash between WISPACE token verify and the local upsert leaves a
 * recoverable intent — `DiscordLinkReconcileCronService` re-commits the
 * mapping from here.
 */
@Injectable()
export class TypeormDiscordLinkVerifyRecordRepository implements DiscordLinkVerifyRecordRepositoryPort {
  constructor(
    @InjectRepository(DiscordLinkVerifyRecordEntity)
    private readonly repo: Repository<DiscordLinkVerifyRecordEntity>,
  ) {}

  /** Upsert the verify intent (idempotent — a retried callback overwrites). */
  async recordVerify(discordUserId: string, userId: number): Promise<void> {
    await this.repo.upsert({ discordUserId, userId, verifiedAt: new Date() }, [
      'discordUserId',
    ]);
  }

  /** Delete the intent once the mapping is committed (fire-and-forget safe). */
  async consumeRecord(discordUserId: string): Promise<void> {
    await this.repo.delete({ discordUserId });
  }

  /** Verify intents older than `olderThanMs` — candidates for reconciliation. */
  async listStaleRecords(olderThanMs: number): Promise<StaleVerifyRecord[]> {
    // ponytail: bounded batch — matches Zalo's take:100, drains across ticks
    const rows = await this.repo
      .createQueryBuilder('record')
      .where('record.verified_at < :cutoff', {
        cutoff: subMilliseconds(new Date(), olderThanMs),
      })
      .orderBy('record.verified_at', 'ASC')
      .take(100)
      .getMany();

    return rows.map((row) => ({
      discordUserId: row.discordUserId,
      userId: row.userId,
      verifiedAt: row.verifiedAt,
    }));
  }

  /** Pending intent for one Discord id, when the callback is still in flight. */
  async findPending(
    discordUserId: string,
  ): Promise<PendingVerifyRecord | undefined> {
    const row = await this.repo.findOne({
      where: { discordUserId },
      select: { userId: true, verifiedAt: true },
    });
    return row ? { userId: row.userId, verifiedAt: row.verifiedAt } : undefined;
  }
}
