import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { extractQueryRows } from '@wispace/bot-common/utils';
import type { LinkMappingObservation } from '@wispace/account-link-core/core';
import { ZaloLinkVerifyRecordEntity } from '../../../infrastructure/database/entities/zalo-link-verify-record.entity';
import type {
  PendingZaloVerifyRecord,
  StaleZaloVerifyRecord,
  ZaloLinkVerifyRecordRepositoryPort,
} from '../domain/ports/zalo-link-verify-record.repository.port';

@Injectable()
export class TypeormZaloLinkVerifyRecordRepository implements ZaloLinkVerifyRecordRepositoryPort {
  constructor(
    @InjectRepository(ZaloLinkVerifyRecordEntity)
    private readonly repo: Repository<ZaloLinkVerifyRecordEntity>,
  ) {}

  async recordVerify(
    zaloUserId: string,
    userId: number,
    mappingObservation: LinkMappingObservation,
  ): Promise<{ intentGeneration: string }> {
    const rows = extractQueryRows<{ intent_generation: string }>(
      await this.repo.query(
        `INSERT INTO zalo_link_verify_records
           (zalo_user_id, user_id, verified_at, intent_generation,
            observed_mapping_kind, observed_mapping_generation)
         VALUES ($1, $2, now(), 1, $3, $4)
         ON CONFLICT (zalo_user_id) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           verified_at = EXCLUDED.verified_at,
           intent_generation = zalo_link_verify_records.intent_generation + 1,
           observed_mapping_kind = EXCLUDED.observed_mapping_kind,
           observed_mapping_generation = EXCLUDED.observed_mapping_generation
         RETURNING intent_generation`,
        [
          zaloUserId,
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
      throw new Error('Zalo link intent upsert returned no generation');
    }
    return { intentGeneration: String(intentGeneration) };
  }

  async consumeRecord(input: {
    zaloUserId: string;
    userId: number;
    intentGeneration: string;
  }): Promise<boolean> {
    const rows = extractQueryRows<{ zalo_user_id: string }>(
      await this.repo.query(
        `DELETE FROM zalo_link_verify_records
         WHERE zalo_user_id = $1 AND user_id = $2 AND intent_generation = $3::bigint
         RETURNING zalo_user_id`,
        [input.zaloUserId, input.userId, input.intentGeneration],
      ),
    );
    return rows.length > 0;
  }

  async discardRecord(zaloUserId: string): Promise<void> {
    await this.repo.delete({ zaloUserId });
  }

  async listStaleRecords(
    olderThanMs: number,
  ): Promise<StaleZaloVerifyRecord[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await this.repo.find({
      where: { verifiedAt: LessThan(cutoff) },
      order: { verifiedAt: 'ASC' },
      take: 100,
    });
    return rows.map((row) => ({
      zaloUserId: row.zaloUserId,
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

  async findPending(
    zaloUserId: string,
  ): Promise<PendingZaloVerifyRecord | undefined> {
    const row = await this.repo.findOne({ where: { zaloUserId } });
    return row ? { userId: row.userId, verifiedAt: row.verifiedAt } : undefined;
  }
}
