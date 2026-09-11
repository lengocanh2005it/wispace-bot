import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { subMilliseconds } from 'date-fns';
import { extractQueryRows } from '@wispace/bot-common/utils';
import { MessengerLinkVerifyRecordEntity } from '@messenger/infrastructure/database/entities/messenger-link-verify-record.entity';
import type {
  MessengerLinkIntentClaimResult,
  MessengerLinkVerifyRecord,
  MessengerLinkVerifyRecordInput,
  MessengerLinkVerifyRecordResult,
  MessengerLinkVerifyRecordRepositoryPort,
  StaleVerifyRecord,
} from '../../domain/ports/messenger-link-verify-record.repository.port';

/**
 * TypeORM implementation of the verify-intent outbox port (#384/#821).
 * The link flow records and leases the verify BEFORE committing the mapping,
 * so a crash between WISPACE token verify and the local upsert leaves a
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
        status: In(['pending', 'processing', 'committed']),
      },
    });

    return row ? this.mapRow(row) : null;
  }

  async findByPsid(psid: string): Promise<MessengerLinkVerifyRecord | null> {
    const row = await this.repo.findOne({ where: { psid } });
    return row ? this.mapRow(row) : null;
  }

  /** Persist the latest intent and reserve its mapping-completion lease. */
  async recordVerify(
    input: MessengerLinkVerifyRecordInput,
  ): Promise<MessengerLinkVerifyRecordResult> {
    const rows = extractQueryRows<{
      intent_generation: string;
      status: MessengerLinkVerifyRecord['status'];
      lease_token: string;
    }>(
      await this.repo.manager.query(
        `
        INSERT INTO messenger_link_verify_records
          (psid, user_id, ref_fingerprint, topic, cadence, status, verified_at,
           lease_token, lease_expires_at)
        VALUES (
          $1, $2, $3, $4, $5, 'processing', now(), gen_random_uuid(),
          now() + ($6::int * interval '1 millisecond')
        )
        ON CONFLICT (psid) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          ref_fingerprint = EXCLUDED.ref_fingerprint,
          topic = EXCLUDED.topic,
          cadence = EXCLUDED.cadence,
          status = 'processing',
          lease_token = gen_random_uuid(),
          lease_expires_at = now() + ($6::int * interval '1 millisecond'),
          verified_at = now(),
          intent_generation = messenger_link_verify_records.intent_generation + 1
        -- An in-flight callback owns its intent until the lease completes or
        -- expires. A concurrent verification must not replace that intent
        -- while the callback can still commit its mapping.
        WHERE messenger_link_verify_records.status <> 'processing'
           OR messenger_link_verify_records.lease_expires_at IS NULL
           OR messenger_link_verify_records.lease_expires_at <= now()
        RETURNING intent_generation, status, lease_token
      `,
        [
          input.psid,
          input.userId,
          input.refFingerprint,
          input.topic,
          input.cadence,
          input.leaseMs,
        ],
      ),
    );

    const generation = rows[0]?.intent_generation;
    if (generation === undefined) {
      const current = await this.repo.findOne({ where: { psid: input.psid } });
      if (!current) {
        throw new Error('Messenger link intent upsert returned no generation');
      }

      return {
        intentGeneration: String(current.intentGeneration),
        intentState: current.status,
      };
    }

    return {
      intentGeneration: String(generation),
      intentState: rows[0].status,
      leaseToken: rows[0].lease_token,
    };
  }

  async claimRecord(params: {
    psid: string;
    userId: number;
    intentGeneration: string;
    leaseMs: number;
    leaseToken?: string;
  }): Promise<MessengerLinkIntentClaimResult> {
    const rows = extractQueryRows<{ lease_token: string }>(
      await this.repo.manager.query(
        `
        UPDATE messenger_link_verify_records
           SET status = 'processing',
               lease_token = COALESCE($5::uuid, gen_random_uuid()),
               lease_expires_at = now() + ($4::int * interval '1 millisecond')
         WHERE psid = $1
           AND user_id = $2
           AND intent_generation = $3::bigint
           AND (
             (
               $5::uuid IS NOT NULL
               AND status = 'processing'
               AND lease_token = $5::uuid
               AND lease_expires_at > now()
             )
             OR (
               $5::uuid IS NULL
               AND (
                 status = 'pending'
                 OR (
                   status = 'processing'
                   AND (lease_expires_at IS NULL OR lease_expires_at <= now())
                 )
               )
             )
           )
        RETURNING lease_token
        `,
        [
          params.psid,
          params.userId,
          params.intentGeneration,
          params.leaseMs,
          params.leaseToken ?? null,
        ],
      ),
    );

    const leaseToken = rows[0]?.lease_token;
    if (leaseToken) {
      return { status: 'claimed', leaseToken };
    }

    const current = await this.repo.findOne({
      where: {
        psid: params.psid,
        userId: params.userId,
        intentGeneration: params.intentGeneration,
      },
    });

    if (!current) {
      return { status: 'not_found' };
    }
    if (current.status === 'committed') {
      return { status: 'already_committed' };
    }
    if (current.status === 'processing') {
      return { status: 'already_processing' };
    }
    return { status: 'not_found' };
  }

  async completeRecord(params: {
    psid: string;
    userId: number;
    intentGeneration: string;
    leaseToken: string;
  }): Promise<'committed' | 'already_committed' | 'not_found'> {
    const result = await this.repo
      .createQueryBuilder()
      .update(MessengerLinkVerifyRecordEntity)
      .set({
        status: 'committed',
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(
        'psid = :psid AND user_id = :userId AND intent_generation = :intentGeneration AND status = :processing AND lease_token = :leaseToken',
        {
          ...params,
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

  async renewRecord(params: {
    psid: string;
    userId: number;
    intentGeneration: string;
    leaseToken: string;
    leaseMs: number;
  }): Promise<boolean> {
    const result = await this.repo.manager.query(
      `
      UPDATE messenger_link_verify_records
         SET lease_expires_at = now() + ($5::int * interval '1 millisecond')
       WHERE psid = $1
         AND user_id = $2
         AND intent_generation = $3::bigint
         AND status = 'processing'
         AND lease_token = $4::uuid
         AND lease_expires_at > now()
      RETURNING 1
      `,
      [
        params.psid,
        params.userId,
        params.intentGeneration,
        params.leaseToken,
        params.leaseMs,
      ],
    );

    return extractQueryRows(result).length > 0;
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
    const now = new Date();
    const rows = await this.repo
      .createQueryBuilder('record')
      .where('(record.status = :pending AND record.verified_at < :cutoff)', {
        pending: 'pending',
        cutoff: subMilliseconds(now, olderThanMs),
      })
      .orWhere(
        '(record.status = :processing AND (record.lease_expires_at IS NULL OR record.lease_expires_at < :now))',
        { processing: 'processing', now },
      )
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
      leaseToken: row.leaseToken,
      leaseExpiresAt: row.leaseExpiresAt,
    };
  }
}
