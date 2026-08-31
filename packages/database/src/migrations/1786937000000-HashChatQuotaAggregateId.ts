import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Data minimization (#640/#541): `chat_quota_events.aggregate_id` stored the
 * raw Messenger PSID. Backfills it to a SHA-256 hex digest (matches Node
 * `hashExternalId` from @wispace/bot-common/masking, which now hashes at
 * write time) and re-claims the audit-table comment. Raw identifiers in
 * non-key columns are no longer persisted for this table.
 */
export class HashChatQuotaAggregateId1786937000000 implements MigrationInterface {
  name = 'HashChatQuotaAggregateId1786937000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Idempotent: only touch rows that are not already a 64-char hex digest.
    await queryRunner.query(`
      UPDATE "chat_quota_events"
      SET "aggregate_id" = encode(sha256(convert_to("aggregate_id", 'UTF8')), 'hex')
      WHERE "aggregate_id" IS NOT NULL
        AND "aggregate_id" !~ '^[0-9a-f]{64}$'
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "chat_quota_events"."aggregate_id" IS
        'SHA-256 hex of the external user id (pseudonymized, #640)'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // One-way: raw ids cannot be recovered from their digests.
    await queryRunner.query(`
      COMMENT ON COLUMN "chat_quota_events"."aggregate_id" IS NULL
    `);
  }
}
