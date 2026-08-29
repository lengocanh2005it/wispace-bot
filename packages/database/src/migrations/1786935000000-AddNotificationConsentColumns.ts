import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Explicit per-feature notification consent (#596):
 * - `report_enabled` / `reminder_enabled` on `user_notification_preferences`
 *   (NULL = feature default: report off, reminder on).
 * - `optin_prompt_sent_at` / `optout_notice_sent_at` markers on the Discord
 *   and Zalo link rows (post-link explainer + grandfather opt-out footer).
 *
 * Grandfather backfill: every learner who would receive a report today
 * (active Discord/Zalo link, Messenger mapping with cadence+topic) gets
 * `report_enabled = true` — status quo preserved, reversible via down().
 */
export class AddNotificationConsentColumns1786935000000 implements MigrationInterface {
  name = 'AddNotificationConsentColumns1786935000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "user_notification_preferences"
        ADD COLUMN IF NOT EXISTS "report_enabled" boolean,
        ADD COLUMN IF NOT EXISTS "reminder_enabled" boolean
    `);
    await queryRunner.query(`
      ALTER TABLE "discord_account_links"
        ADD COLUMN IF NOT EXISTS "optin_prompt_sent_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "optout_notice_sent_at" timestamptz
    `);
    await queryRunner.query(`
      ALTER TABLE "zalo_account_links"
        ADD COLUMN IF NOT EXISTS "optin_prompt_sent_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "optout_notice_sent_at" timestamptz
    `);

    // Grandfather: active Discord links.
    const discord = await queryRunner.query(`
      INSERT INTO "user_notification_preferences" ("user_id", "report_enabled", "updated_at")
      SELECT dal.user_id, true, now()
      FROM "discord_account_links" dal
      WHERE dal.user_id IS NOT NULL AND COALESCE(dal.link_state, 'active') = 'active'
      ON CONFLICT ("user_id") DO UPDATE
        SET "report_enabled" = true, "updated_at" = now()
      RETURNING user_id
    `);
    // Grandfather: active Zalo links.
    const zalo = await queryRunner.query(`
      INSERT INTO "user_notification_preferences" ("user_id", "report_enabled", "updated_at")
      SELECT zal.user_id, true, now()
      FROM "zalo_account_links" zal
      WHERE zal.user_id IS NOT NULL AND COALESCE(zal.link_state, 'active') = 'active'
      ON CONFLICT ("user_id") DO UPDATE
        SET "report_enabled" = true, "updated_at" = now()
      RETURNING user_id
    `);
    // Grandfather: Messenger mappings already subscribed (cadence + topic set).
    const messenger = await queryRunner.query(`
      INSERT INTO "user_notification_preferences" ("user_id", "report_enabled", "updated_at")
      SELECT upm.user_id, true, now()
      FROM "user_platform_mappings" upm
      WHERE upm.status = 'ACTIVE'
        AND upm.cadence IS NOT NULL AND upm.topic IS NOT NULL
        AND upm.user_id IS NOT NULL
      ON CONFLICT ("user_id") DO UPDATE
        SET "report_enabled" = true, "updated_at" = now()
      RETURNING user_id
    `);
    // #596 AC: the rollout default is logged (enrolled learner counts).
    console.log(
      `[consent-grandfather] report_enabled=true enrolled: discord=${discord.length}, zalo=${zalo.length}, messenger=${messenger.length}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "zalo_account_links"
        DROP COLUMN IF EXISTS "optout_notice_sent_at",
        DROP COLUMN IF EXISTS "optin_prompt_sent_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "discord_account_links"
        DROP COLUMN IF EXISTS "optout_notice_sent_at",
        DROP COLUMN IF EXISTS "optin_prompt_sent_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "user_notification_preferences"
        DROP COLUMN IF EXISTS "reminder_enabled",
        DROP COLUMN IF EXISTS "report_enabled"
    `);
  }
}
