import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { subMilliseconds } from 'date-fns';
import { extractQueryRows } from '@wispace/bot-common/utils';
import { MessengerLinkVerifyRecordEntity } from '@messenger/infrastructure/database/entities/messenger-link-verify-record.entity';
import type {
  MessengerLinkVerifyRecord,
  MessengerLinkVerifyRecordInput,
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

  async findByRefFingerprint(
    psid: string,
    refFingerprint: string,
  ): Promise<MessengerLinkVerifyRecord | null> {
    const row = await this.repo.findOne({
      where: {
        psid,
        refFingerprint,
        status: In(['pending', 'committed']),
      },
    });

    return row ? this.mapRow(row) : null;
  }

  /** Upsert the latest intent and fence older callbacks with a generation. */
  async recordVerify(
    input: MessengerLinkVerifyRecordInput,
  ): Promise<{ intentGeneration: string }> {
    const rows = extractQueryRows<{ intent_generation: string }>(
      await this.repo.manager.query(
        `
        INSERT INTO messenger_link_verify_records
          (psid, user_id, ref_fingerprint, topic, cadence, status, verified_at)
        VALUES ($1, $2, $3, $4, $5, 'pending', now())
        ON CONFLICT (psid) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          ref_fingerprint = EXCLUDED.ref_fingerprint,
          topic = EXCLUDED.topic,
          cadence = EXCLUDED.cadence,
          status = 'pending',
          verified_at = now(),
          intent_generation = messenger_link_verify_records.intent_generation + 1
        RETURNING intent_generation
      `,
        [
          input.psid,
          input.userId,
          input.refFingerprint,
          input.topic,
          input.cadence,
        ],
      ),
    );

    const generation = rows[0]?.intent_generation;
    if (generation === undefined) {
      throw new Error('Messenger link intent upsert returned no generation');
    }

    return { intentGeneration: String(generation) };
  }

  async consumeRecord(params: {
    psid: string;
    userId: number;
    intentGeneration: string;
  }): Promise<'committed' | 'already_committed' | 'not_found'> {
    const result = await this.repo
      .createQueryBuilder()
      .update(MessengerLinkVerifyRecordEntity)
      .set({ status: 'committed' })
      .where(
        'psid = :psid AND user_id = :userId AND intent_generation = :intentGeneration AND status = :pending',
        {
          ...params,
          pending: 'pending',
        },
      )
      .execute();

    if ((result.affected ?? 0) > 0) {
      return 'committed';
    }

    const committed = await this.repo.findOne({
      where: {
        psid: params.psid,
        userId: params.userId,
        intentGeneration: params.intentGeneration,
        status: 'committed',
      },
    });

    return committed ? 'already_committed' : 'not_found';
  }

  async discardRecord(psid: string, intentGeneration?: string): Promise<void> {
    await this.repo.delete({
      psid,
      ...(intentGeneration ? { intentGeneration } : {}),
    });
  }

  /** Verify intents older than `olderThanMs` — candidates for reconciliation. */
  async listStaleRecords(olderThanMs: number): Promise<StaleVerifyRecord[]> {
    // ponytail: bounded batch — matches Discord's take:100, drains across ticks
    const rows = await this.repo
      .createQueryBuilder('record')
      .where('record.status = :status', { status: 'pending' })
      .andWhere('record.verified_at < :cutoff', {
        cutoff: subMilliseconds(new Date(), olderThanMs),
      })
      .orderBy('record.verified_at', 'ASC')
      .take(100)
      .getMany();

    return rows.map((row) => this.mapRow(row));
  }

  async cleanupCommittedRecords(olderThanMs: number): Promise<number> {
    const result = await this.repo.delete({
      status: 'committed',
      verifiedAt: LessThan(subMilliseconds(new Date(), olderThanMs)),
    });
    return result.affected ?? 0;
  }

  private mapRow(
    row: MessengerLinkVerifyRecordEntity,
  ): MessengerLinkVerifyRecord {
    return {
      psid: row.psid,
      userId: row.userId,
      topic: row.topic,
      cadence: row.cadence,
      refFingerprint: row.refFingerprint,
      intentGeneration: String(row.intentGeneration),
      status: row.status,
      verifiedAt: row.verifiedAt,
    };
  }
}
