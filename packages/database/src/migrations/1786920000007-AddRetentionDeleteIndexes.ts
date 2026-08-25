import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add time-leading indexes for retention-delete predicates on
 * llm_usage_events and chat_quota_events. Without these the cleanup
 * crons do sequential scans on every tick.
 *
 * CONCURRENTLY is not used inside a transaction — TypeORM wraps
 * each migration in a transaction by default, so these are plain
 * CREATE INDEX IF NOT EXISTS. The tables are small enough at current
 * volume that the brief lock is acceptable; switch to CONCURRENTLY
 * if the tables grow past ~10M rows before the next deploy.
 */
export class AddRetentionDeleteIndexes1786920000007 implements MigrationInterface {
  name = 'AddRetentionDeleteIndexes1786920000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_llm_usage_platform_occurred"
      ON "llm_usage_events" ("platform", "occurred_at")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chat_events_occurred_at"
      ON "chat_quota_events" ("occurred_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_chat_events_occurred_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_llm_usage_platform_occurred"`,
    );
  }
}
