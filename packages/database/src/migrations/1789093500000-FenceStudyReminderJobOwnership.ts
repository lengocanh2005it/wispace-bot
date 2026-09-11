import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Carries the mapping generation that authorized a reminder job. Existing
 * rows stay nullable and are deliberately rejected by the dispatch fence
 * until the next authoritative sync rewrites them.
 */
export class FenceStudyReminderJobOwnership1789093500000 implements MigrationInterface {
  name = 'FenceStudyReminderJobOwnership1789093500000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "study_reminder_jobs"
        ADD COLUMN IF NOT EXISTS "mapping_generation" bigint NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_study_reminder_jobs_platform_external_generation"
      ON "study_reminder_jobs" ("platform", "external_user_id", "mapping_generation")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_study_reminder_jobs_platform_external_generation"`,
    );
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" DROP COLUMN IF EXISTS "mapping_generation"`,
    );
  }
}
