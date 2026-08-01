import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Discord OAuth2 account-linking (Discord userId ↔ WISPACE userId).
 * Only `apps/messenger-bot` runs migrations (docs/turborepo-migration-plan.md
 * Phase 5 convention) — messenger-bot itself never reads/writes this table,
 * only `apps/discord-bot` does (its own TypeOrmModule.forFeature).
 */
export class CreateDiscordAccountLinksTable1751029200002 implements MigrationInterface {
  name = 'CreateDiscordAccountLinksTable1751029200002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "discord_account_links" (
        "id"               BIGSERIAL PRIMARY KEY,
        "platform"         character varying(16) NOT NULL DEFAULT 'discord',
        "external_user_id" character varying(64) NOT NULL,
        "user_id"          integer NOT NULL,
        "linked_at"        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_discord_account_links_external_user_id"
        ON "discord_account_links" ("platform", "external_user_id")
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_discord_account_links_user_id"
        ON "discord_account_links" ("platform", "user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_discord_account_links_user_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_discord_account_links_external_user_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "discord_account_links"`);
  }
}
