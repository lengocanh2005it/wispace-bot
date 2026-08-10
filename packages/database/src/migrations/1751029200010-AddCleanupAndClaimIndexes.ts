import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes backing the cleanup/stuck-recovery/cron hot queries:
 * - chat_idempotency (platform, status, reserved_at) — 30-min stuck recovery,
 *   idempotency cleanup, and I1 ops health.
 * - scheduled_report_claims (user_id, report_date, status) — cross-platform
 *   "already sent today" check in the Zalo/Discord report crons.
 * - scheduled_report_claims (created_at) — report-claims retention cleanup.
 * - message_logs (created_at) — weekly audit-log cleanup DELETE (declared on
 *   the entity but never migrated).
 */
export class AddCleanupAndClaimIndexes1751029200010 implements MigrationInterface {
  name = 'AddCleanupAndClaimIndexes1751029200010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chat_idempotency_platform_status_reserved"
      ON "chat_idempotency" ("platform", "status", "reserved_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_scheduled_report_claims_user_date_status"
      ON "scheduled_report_claims" ("user_id", "report_date", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_scheduled_report_claims_created_at"
      ON "scheduled_report_claims" ("created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_msg_log_created"
      ON "message_logs" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_chat_idempotency_platform_status_reserved"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_scheduled_report_claims_user_date_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_scheduled_report_claims_created_at"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_msg_log_created"`);
  }
}
