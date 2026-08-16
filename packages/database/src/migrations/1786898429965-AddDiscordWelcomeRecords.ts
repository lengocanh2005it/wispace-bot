import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Discord welcome-DM dedupe (issues #231/#232/#233):
 * - `discord_welcome_records` — single dedupe state keyed by Discord user id
 *   alone; an unlinked user may never get a mapping row but the welcome
 *   marker must still exist. Shared by the organic and the linked path so a
 *   user welcomed organically is not re-welcomed at link time (#233).
 * - `discord_account_links.last_welcomed_at` is backfilled into the new table
 *   (as `linked` source) then dropped — one marker, never two (#231).
 * Only `apps/messenger-bot` runs migrations (Phase 5 convention).
 */
export class AddDiscordWelcomeRecords1786898429965 implements MigrationInterface {
  name = 'AddDiscordWelcomeRecords1786898429965';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "discord_welcome_records" (
        "discord_user_id"  character varying(64) NOT NULL,
        "last_welcomed_at" TIMESTAMPTZ NULL,
        "source"           character varying(16) NULL,
        "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_discord_welcome_records" PRIMARY KEY ("discord_user_id")
      )
    `);

    await queryRunner.query(`
      INSERT INTO "discord_welcome_records" (
        "discord_user_id", "last_welcomed_at", "source"
      )
      SELECT "external_user_id", "last_welcomed_at", 'linked'
      FROM "discord_account_links"
      WHERE "last_welcomed_at" IS NOT NULL
      ON CONFLICT ("discord_user_id") DO NOTHING
    `);

    await queryRunner.query(`
      ALTER TABLE "discord_account_links"
        DROP COLUMN IF EXISTS "last_welcomed_at"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "discord_account_links"
        ADD COLUMN IF NOT EXISTS "last_welcomed_at" TIMESTAMPTZ NULL
    `);

    // Only linked-path markers can be restored — organic records belong to
    // users who never got a mapping row (their dedupe state is lost on
    // revert, by design).
    await queryRunner.query(`
      UPDATE "discord_account_links" SET "last_welcomed_at" = wr."last_welcomed_at"
      FROM "discord_welcome_records" wr
      WHERE wr."discord_user_id" = "discord_account_links"."external_user_id"
        AND wr."source" = 'linked'
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS "discord_welcome_records"`);
  }
}
