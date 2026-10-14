import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #1507 — the recovery cron scans for due notifications across a table all three
 * bots share. The scan is now scoped to the caller's own platform, and an index
 * that does not lead with `platform` cannot serve that predicate: adding the
 * filter without this index would leave a sequential scan over a table that only
 * grows.
 *
 * The old index is dropped rather than kept. Its only reader was the due-notification
 * scan, and that query now needs `platform` first; retaining it would cost a write
 * amplification on `notification_status` for no query.
 */
export class AddRescheduleAttemptPlatformDueIndex1789094100000 implements MigrationInterface {
  name = 'AddRescheduleAttemptPlatformDueIndex1789094100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_reschedule_attempt_platform_due" ON "reschedule_confirmation_attempts" ("platform", "status", "notification_status", "next_notification_attempt_at")`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_reschedule_attempt_notification_due"`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_reschedule_attempt_notification_due" ON "reschedule_confirmation_attempts" ("status", "notification_status", "next_notification_attempt_at")`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_reschedule_attempt_platform_due"`,
    );
  }
}
