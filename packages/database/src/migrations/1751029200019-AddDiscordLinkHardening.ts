import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Discord link hardening (issue #137):
 * - `discord_account_links.last_welcomed_at` — dedupes welcome DMs across
 *   the OAuth callback / `guildMemberAdd` / re-join race (items 2+4).
 * - `discord_link_verify_records` — durable verify-intent outbox so the
 *   reconciliation cron can re-commit a mapping when the bot crashes
 *   between WISPACE token verify and the local upsert (item 1).
 * Only `apps/messenger-bot` runs migrations (Phase 5 convention).
 */
export class AddDiscordLinkHardening1751029200019 implements MigrationInterface {
  name = 'AddDiscordLinkHardening1751029200019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "discord_account_links"
        ADD COLUMN IF NOT EXISTS "last_welcomed_at" TIMESTAMPTZ NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "discord_link_verify_records" (
        "discord_user_id" character varying(64) NOT NULL,
        "user_id"         integer NOT NULL,
        "verified_at"     TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_discord_link_verify_records" PRIMARY KEY ("discord_user_id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "discord_link_verify_records"`,
    );
    await queryRunner.query(`
      ALTER TABLE "discord_account_links"
        DROP COLUMN IF EXISTS "last_welcomed_at"
    `);
  }
}
