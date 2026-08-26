import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add lifecycle indexes for study_reminder_jobs query paths:
 *
 * 1. (platform, status, remind_at) — covers findNextDueTime and findDueJobs
 *    which filter on platform + status + remind_at ordering.
 *
 * 2. (status, platform, lease_expires_at) — covers resetStuckProcessingJobs
 *    which filters on status = 'processing' + platform + lease expiration.
 *
 * The existing idx_study_reminder_jobs_dispatch on (status, remind_at) does
 * not include platform, forcing a heap filter on every platform-scoped query.
 */
export class AddStudyReminderLifecycleIndexes1786920000010 implements MigrationInterface {
  name = 'AddStudyReminderLifecycleIndexes1786920000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_study_reminder_jobs_platform_status_remind"
      ON "study_reminder_jobs" ("platform", "status", "remind_at")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_study_reminder_jobs_status_platform_lease"
      ON "study_reminder_jobs" ("status", "platform", "lease_expires_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_study_reminder_jobs_status_platform_lease"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_study_reminder_jobs_platform_status_remind"`,
    );
  }
}
