import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add the keyset-pagination index the scheduled fan-out crons need (#1008).
 *
 * Both `findActiveMappingsPage` (reminders) and
 * `findActiveSubscribedMappingsPage` (scheduled reports) page with equality on
 * (platform, status) and `id > $after ORDER BY id ASC LIMIT n`. The existing
 * `idx_platform_mappings_external_status` cannot serve that: its second column
 * is `external_user_id`, which neither query filters on, so the planner stops
 * at the leading `platform` predicate and must sort. The fallback plan is a
 * primary-key scan that discards every INACTIVE row and every other platform's
 * rows, and it degrades as inactive mappings accumulate.
 *
 * CONCURRENTLY is deliberately not used, matching
 * `1786920000007-AddRetentionDeleteIndexes`: TypeORM runs the whole chain under
 * `migrationsTransactionMode: 'all'` (the default this repo never overrides),
 * and a per-migration `transaction = false` override throws
 * `ForbiddenTransactionModeOverrideError` under that mode — it would break the
 * entire chain, not just this migration. Switching the mode to 'each' changes
 * chain atomicity for all migrations and is tracked separately by #524.
 * `user_platform_mappings` holds one row per linked learner, so the SHARE lock
 * during the build is short; revisit if the table grows past ~1M rows.
 */
export class AddPlatformMappingKeysetIndex1789093300000 implements MigrationInterface {
  name = 'AddPlatformMappingKeysetIndex1789093300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_platform_mappings_platform_status_id"
      ON "user_platform_mappings" ("platform", "status", "id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_platform_mappings_platform_status_id"`,
    );
  }
}
