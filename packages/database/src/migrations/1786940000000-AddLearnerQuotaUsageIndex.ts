import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #637: the daily LLM quota is learner-scoped when a link has a WISPACE
 * userId. Keep the legacy channel key for anonymous links, but index the
 * learner/date aggregate used by the reservation transaction.
 */
export class AddLearnerQuotaUsageIndex1786940000000 implements MigrationInterface {
  name = 'AddLearnerQuotaUsageIndex1786940000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chat_daily_usage_user_date"
      ON "chat_daily_usage" ("user_id", "usage_date")
      WHERE "user_id" IS NOT NULL
    `);
    await queryRunner.query(`
      COMMENT ON COLUMN "chat_quota_events"."aggregate_id" IS
        'SHA-256 hex of the canonical learner user id when linked, otherwise the external user id (#637/#640)'
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // The index predates this migration on upgraded databases (it was created
    // with the original Messenger quota tables), so dropping it here would
    // remove an index owned by an earlier migration.
  }
}
