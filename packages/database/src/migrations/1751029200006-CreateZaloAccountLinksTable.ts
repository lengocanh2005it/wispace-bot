import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Zalo Login account-linking (Zalo userId ↔ WISPACE userId). Only
 * `apps/messenger-bot` runs migrations; only `apps/zalo-bot` reads/writes
 * this table (its own TypeOrmModule.forFeature).
 */
export class CreateZaloAccountLinksTable1751029200006 implements MigrationInterface {
  name = 'CreateZaloAccountLinksTable1751029200006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "zalo_account_links" (
        "id"               BIGSERIAL PRIMARY KEY,
        "platform"         character varying(16) NOT NULL DEFAULT 'zalo',
        "external_user_id" character varying(64) NOT NULL,
        "user_id"          integer NOT NULL,
        "linked_at"        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_zalo_account_links_external_user_id"
        ON "zalo_account_links" ("platform", "external_user_id")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_zalo_account_links_user_id"
        ON "zalo_account_links" ("platform", "user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_zalo_account_links_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_zalo_account_links_external_user_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "zalo_account_links"`);
  }
}
