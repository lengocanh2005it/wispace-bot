import type { MigrationInterface, QueryRunner } from 'typeorm';
import { currentChatUsageDate } from '../chat-usage-date';

/**
 * #1177 / ADR-0027 — owner-aware daily FREE_FORM usage.
 *
 * The legacy unique key on `(platform, external_user_id, usage_date)` allowed
 * one row per channel/date and made link/unlink rewrite its nullable
 * `user_id`. That rewrite erased the difference between a learner bucket and
 * an anonymous bucket, so a learner could reset their consumed count by
 * unlinking, sending an anonymous turn, and relinking.
 *
 * Owner-aware uniqueness replaces it: linked rows are unique per
 * channel/date/owner, the anonymous row is unique per channel/date, and the two
 * can coexist without either owner being rewritten.
 *
 * Rollout contract: every bot is deployed with the legacy-key compatibility
 * path before this migration drops the old key. The self-pull deploy then runs
 * this migration only after all three owner-aware images are serving, so a
 * failed migration leaves the legacy schema and its compatibility path intact.
 * A rollback must not restore the legacy key while both owners coexist (see
 * `down`).
 */
export class OwnerAwareChatDailyUsageKeys1789093800000 implements MigrationInterface {
  name = 'OwnerAwareChatDailyUsageKeys1789093800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const usageDate = currentChatUsageDate();

    // Expand first. Statements run in the migration transaction, so readers
    // continue to see the legacy key until the new indexes and backfill commit.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_daily_usage_linked"
      ON "chat_daily_usage" ("platform", "external_user_id", "usage_date", "user_id")
      WHERE "user_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_daily_usage_anonymous"
      ON "chat_daily_usage" ("platform", "external_user_id", "usage_date")
      WHERE "user_id" IS NULL
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_chat_daily_usage_platform_external_date"`,
    );

    // Conservative one-time fix-up for the current quota day. Before this
    // migration an anonymous row reachable through an active mapping was
    // hydrated into the learner bucket at read time; runtime no longer does
    // that, so copy the current count into the learner bucket as well. This can
    // deny quota for at most one day, but it cannot grant quota that identity
    // churn already consumed. Older ambiguous rows stay anonymous.
    //
    // The quota day is the configured chat timezone's day; ICT is the documented
    // default (`CHAT_USAGE_TIMEZONE`). A deployment on another timezone only
    // shifts which single day this fix-up over-denies.
    await queryRunner.query(
      `
      INSERT INTO "chat_daily_usage" (
        "platform", "external_user_id", "user_id", "usage_date", "free_form_count"
      )
      SELECT
        usage."platform",
        usage."external_user_id",
        link."user_id",
        usage."usage_date",
        usage."free_form_count"
      FROM "chat_daily_usage" usage
      JOIN (
        SELECT 'messenger' AS platform, external_user_id, user_id
        FROM user_platform_mappings
        WHERE status = 'ACTIVE' AND link_state = 'active'
          AND external_user_id IS NOT NULL AND user_id IS NOT NULL
        UNION ALL
        SELECT 'discord', external_user_id, user_id
        FROM discord_account_links
        WHERE link_state = 'active'
          AND external_user_id IS NOT NULL AND user_id IS NOT NULL
        UNION ALL
        SELECT 'zalo', external_user_id, user_id
        FROM zalo_account_links
        WHERE link_state = 'active'
          AND external_user_id IS NOT NULL AND user_id IS NOT NULL
      ) link
        ON link.platform = usage."platform"
       AND link.external_user_id = usage."external_user_id"
      WHERE usage."user_id" IS NULL
        AND usage."usage_date" = $1::date
      ON CONFLICT ("platform", "external_user_id", "usage_date", "user_id")
        WHERE "user_id" IS NOT NULL
        DO NOTHING
    `,
      [usageDate],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_chat_daily_usage_anonymous"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_chat_daily_usage_linked"`,
    );
    // Restoring the legacy key only succeeds while no channel/date holds both a
    // learner row and an anonymous row. It deliberately fails instead of merging
    // the buckets back together (ADR-0027).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_daily_usage_platform_external_date"
      ON "chat_daily_usage" ("platform", "external_user_id", "usage_date")
    `);
  }
}
