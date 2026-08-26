import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Messenger link verify-intent outbox (issue #384):
 * `messenger_link_verify_records` — durable verify-intent outbox so the
 * reconciliation cron can re-commit a mapping when the bot crashes
 * between WISPACE token verify and the local upsert.
 * Only `apps/messenger-bot` runs migrations (Phase 5 convention).
 */
export class AddMessengerLinkVerifyRecords1786920000012 implements MigrationInterface {
  name = 'AddMessengerLinkVerifyRecords1786920000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messenger_link_verify_records" (
        "psid"         character varying(64) NOT NULL,
        "user_id"      integer NOT NULL,
        "verified_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_messenger_link_verify_records" PRIMARY KEY ("psid")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "messenger_link_verify_records"`,
    );
  }
}
