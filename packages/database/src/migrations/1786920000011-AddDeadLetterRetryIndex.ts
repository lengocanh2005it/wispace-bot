import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add composite index for dead-letter retry query path (listPendingForRetry):
 *   WHERE platform = ? AND status = 'pending' AND direction = 'outbound'
 *   AND updated_at < ? ORDER BY created_at
 *
 * The existing idx_webhook_dead_letter_platform_status_created covers
 * (platform, status, created_at) but not direction or updated_at — every
 * pending row must be heap-filtered for direction = 'outbound'.
 */
export class AddDeadLetterRetryIndex1786920000011 implements MigrationInterface {
  name = 'AddDeadLetterRetryIndex1786920000011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_webhook_dead_letter_retry"
      ON "webhook_dead_letters" ("platform", "status", "direction", "updated_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_webhook_dead_letter_retry"`,
    );
  }
}
