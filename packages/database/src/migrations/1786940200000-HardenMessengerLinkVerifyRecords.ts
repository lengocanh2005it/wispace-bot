import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds identity, replay, metadata, and terminal-state fencing to Messenger link intents. */
export class HardenMessengerLinkVerifyRecords1786940200000 implements MigrationInterface {
  name = 'HardenMessengerLinkVerifyRecords1786940200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "messenger_link_verify_records"
        ADD COLUMN IF NOT EXISTS "intent_generation" bigint NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS "ref_fingerprint" character varying(64),
        ADD COLUMN IF NOT EXISTS "topic" character varying(100) NOT NULL DEFAULT 'IELTS',
        ADD COLUMN IF NOT EXISTS "cadence" character varying(10) NOT NULL DEFAULT 'WEEKLY',
        ADD COLUMN IF NOT EXISTS "status" character varying(16) NOT NULL DEFAULT 'pending'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messenger_link_verify_pending_stale"
        ON "messenger_link_verify_records" ("status", "verified_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_messenger_link_verify_pending_stale"`,
    );
    await queryRunner.query(`
      ALTER TABLE "messenger_link_verify_records"
        DROP COLUMN IF EXISTS "status",
        DROP COLUMN IF EXISTS "cadence",
        DROP COLUMN IF EXISTS "topic",
        DROP COLUMN IF EXISTS "ref_fingerprint",
        DROP COLUMN IF EXISTS "intent_generation"
    `);
  }
}
