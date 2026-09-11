import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { subMilliseconds } from 'date-fns';
import { extractQueryRows } from '@wispace/bot-common/utils';
import type { LinkMappingObservation } from '@wispace/account-link-core/core';
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

  /** Upsert the latest intent and fence older callbacks with a generation. */
  async recordVerify(
    discordUserId: string,
    userId: number,
    mappingObservation: LinkMappingObservation,
  ): Promise<{ intentGeneration: string }> {
    const rows = extractQueryRows<{ intent_generation: string }>(
      await this.repo.query(
        `INSERT INTO discord_link_verify_records
           (discord_user_id, user_id, verified_at, intent_generation,
            observed_mapping_kind, observed_mapping_generation)
         VALUES ($1, $2, now(), 1, $3, $4)
         ON CONFLICT (discord_user_id) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           verified_at = EXCLUDED.verified_at,
           intent_generation = discord_link_verify_records.intent_generation + 1,
           observed_mapping_kind = EXCLUDED.observed_mapping_kind,
           observed_mapping_generation = EXCLUDED.observed_mapping_generation
         RETURNING intent_generation`,
        [
          discordUserId,
          userId,
          mappingObservation.kind,
          mappingObservation.kind === 'present'
            ? mappingObservation.generation
            : null,
        ],
      ),
    );
    const intentGeneration = rows[0]?.intent_generation;
    if (intentGeneration === undefined) {
      throw new Error('Discord link intent upsert returned no generation');
    }
    return { intentGeneration: String(intentGeneration) };
  }

  async consumeRecord(input: {
    discordUserId: string;
    userId: number;
    intentGeneration: string;
  }): Promise<boolean> {
    const rows = extractQueryRows<{ discord_user_id: string }>(
      await this.repo.query(
        `DELETE FROM discord_link_verify_records
         WHERE discord_user_id = $1 AND user_id = $2 AND intent_generation = $3::bigint
         RETURNING discord_user_id`,
        [input.discordUserId, input.userId, input.intentGeneration],
      ),
    );
    return rows.length > 0;
  }

  async discardRecord(discordUserId: string): Promise<void> {
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
      intentGeneration: String(row.intentGeneration),
      verifiedAt: row.verifiedAt,
      mappingObservation:
        row.observedMappingKind === 'present'
          ? {
              kind: 'present',
              generation: String(row.observedMappingGeneration),
            }
          : { kind: 'absent' },
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
