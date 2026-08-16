import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Zalo link verify-intent outbox (#147, mirror of Discord #137): inserted
 * AFTER WISPACE consumes the single-use link token and BEFORE the local
 * mapping upsert; the zalo-link-reconcile cron re-commits the mapping when
 * the bot crashes in between.
 */
export class AddZaloLinkVerifyRecords1786890667352 implements MigrationInterface {
  name = 'AddZaloLinkVerifyRecords1786890667352';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "zalo_link_verify_records" (
        "zalo_user_id" varchar(64) NOT NULL,
        "user_id" integer NOT NULL,
        "verified_at" timestamptz NOT NULL,
        PRIMARY KEY ("zalo_user_id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "zalo_link_verify_records"`);
  }
}
