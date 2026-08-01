import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2 of the Turborepo multi-bot migration (docs/turborepo-migration-plan.md).
 * Generalizes every table keyed by Facebook Messenger `psid` into a
 * `(platform, external_user_id)` pair so Discord/Zalo bots can share these
 * tables later without colliding with Messenger rows. Existing rows backfill
 * to platform='messenger' via column default.
 */
export class GeneralizePlatformIdentifiers1751029200001 implements MigrationInterface {
  name = 'GeneralizePlatformIdentifiers1751029200001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- user_messenger_mappings -> user_platform_mappings ----------------
    await queryRunner.query(
      `ALTER TABLE "user_messenger_mappings" RENAME TO "user_platform_mappings"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_platform_mappings" RENAME COLUMN "psid" TO "external_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_platform_mappings" ADD COLUMN "platform" character varying(16) NOT NULL DEFAULT 'messenger'`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_mappings_active_psid_unique"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_mappings_psid_status"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_platform_mappings_active_external_unique"
      ON "user_platform_mappings" ("platform", "external_user_id")
      WHERE status = 'ACTIVE' AND external_user_id IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_platform_mappings_external_status"
      ON "user_platform_mappings" ("platform", "external_user_id", "status")
    `);

    // ---- messenger_chat_daily_usage -> chat_daily_usage --------------------
    await queryRunner.query(
      `ALTER TABLE "messenger_chat_daily_usage" RENAME TO "chat_daily_usage"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_daily_usage" RENAME COLUMN "psid" TO "external_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_daily_usage" ADD COLUMN "platform" character varying(16) NOT NULL DEFAULT 'messenger'`,
    );
    // Created as an inline table CONSTRAINT in the original migration, not a
    // plain index — DROP INDEX fails on it (needs DROP CONSTRAINT).
    await queryRunner.query(
      `ALTER TABLE "chat_daily_usage" DROP CONSTRAINT IF EXISTS "uq_chat_daily_usage_psid_date"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_daily_usage_platform_external_date"
      ON "chat_daily_usage" ("platform", "external_user_id", "usage_date")
    `);

    // ---- messenger_chat_idempotency -> chat_idempotency --------------------
    await queryRunner.query(
      `ALTER TABLE "messenger_chat_idempotency" RENAME TO "chat_idempotency"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_idempotency" RENAME COLUMN "psid" TO "external_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_idempotency" ADD COLUMN "platform" character varying(16) NOT NULL DEFAULT 'messenger'`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_chat_idempotency_psid_date"`,
    );
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chat_idempotency_platform_external_date"
      ON "chat_idempotency" ("platform", "external_user_id", "usage_date")
    `);

    // ---- messenger_message_logs -> message_logs -----------------------------
    await queryRunner.query(
      `ALTER TABLE "messenger_message_logs" RENAME TO "message_logs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_logs" RENAME COLUMN "psid" TO "external_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_logs" ADD COLUMN "platform" character varying(16) NOT NULL DEFAULT 'messenger'`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_msg_logs_psid_created_at"`,
    );
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_msg_logs_platform_external_created_at"
      ON "message_logs" ("platform", "external_user_id", "created_at" DESC)
    `);

    // ---- messenger_scheduled_report_claims -> scheduled_report_claims ------
    await queryRunner.query(
      `ALTER TABLE "messenger_scheduled_report_claims" RENAME TO "scheduled_report_claims"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" RENAME COLUMN "psid" TO "external_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" ADD COLUMN "platform" character varying(16) NOT NULL DEFAULT 'messenger'`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_messenger_scheduled_report_claims_psid_date"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_scheduled_report_claims_platform_external_date"
      ON "scheduled_report_claims" ("platform", "external_user_id", "report_date")
    `);

    // ---- messenger_webhook_dead_letters -> webhook_dead_letters -------------
    await queryRunner.query(
      `ALTER TABLE "messenger_webhook_dead_letters" RENAME TO "webhook_dead_letters"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" RENAME COLUMN "psid" TO "external_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" ADD COLUMN "platform" character varying(16) NOT NULL DEFAULT 'messenger'`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_webhook_dead_letter_psid"`,
    );
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_webhook_dead_letter_platform_external"
      ON "webhook_dead_letters" ("platform", "external_user_id")
      WHERE "external_user_id" IS NOT NULL
    `);

    // ---- messenger_chat_events -> chat_quota_events -------------------------
    // aggregate_id is already platform-agnostic (event-sourced quota key); just
    // add a platform column for consistency/filtering.
    await queryRunner.query(
      `ALTER TABLE "messenger_chat_events" RENAME TO "chat_quota_events"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_quota_events" ADD COLUMN "platform" character varying(16) NOT NULL DEFAULT 'messenger'`,
    );

    // ---- study_reminder_jobs (table name unchanged) -------------------------
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" RENAME COLUMN "psid" TO "external_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" ADD COLUMN "platform" character varying(16) NOT NULL DEFAULT 'messenger'`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_study_reminder_jobs_psid_session_key"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_study_reminder_jobs_platform_external_session_key"
      ON "study_reminder_jobs" ("platform", "external_user_id", "session_key")
    `);

    // ---- report_send_jobs (table name unchanged) -----------------------------
    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" RENAME COLUMN "psid" TO "external_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" ADD COLUMN "platform" character varying(16) NOT NULL DEFAULT 'messenger'`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_report_send_jobs_psid_exam_date"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_report_send_jobs_platform_external_exam_date"
      ON "report_send_jobs" ("platform", "external_user_id", "exam_date")
    `);

    // ---- llm_usage_events (table name unchanged) -----------------------------
    await queryRunner.query(
      `ALTER TABLE "llm_usage_events" RENAME COLUMN "psid" TO "external_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "llm_usage_events" ADD COLUMN "platform" character varying(16) NOT NULL DEFAULT 'messenger'`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_llm_usage_psid_date"`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_llm_usage_platform_external_date"
      ON "llm_usage_events" ("platform", "external_user_id", "usage_date")
      WHERE "external_user_id" IS NOT NULL
    `);

    // ---- llm_safety_events (table name unchanged) -----------------------------
    await queryRunner.query(
      `ALTER TABLE "llm_safety_events" RENAME COLUMN "psid" TO "external_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "llm_safety_events" ADD COLUMN "platform" character varying(16) NOT NULL DEFAULT 'messenger'`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_llm_safety_psid"`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_llm_safety_platform_external"
      ON "llm_safety_events" ("platform", "external_user_id")
      WHERE "external_user_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // llm_safety_events
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_llm_safety_platform_external"`,
    );
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_llm_safety_psid"
      ON "llm_safety_events" ("external_user_id")
      WHERE "external_user_id" IS NOT NULL
    `);
    await queryRunner.query(
      `ALTER TABLE "llm_safety_events" DROP COLUMN "platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "llm_safety_events" RENAME COLUMN "external_user_id" TO "psid"`,
    );

    // llm_usage_events
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_llm_usage_platform_external_date"`,
    );
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_llm_usage_psid_date"
      ON "llm_usage_events" ("external_user_id", "usage_date")
      WHERE "external_user_id" IS NOT NULL
    `);
    await queryRunner.query(
      `ALTER TABLE "llm_usage_events" DROP COLUMN "platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "llm_usage_events" RENAME COLUMN "external_user_id" TO "psid"`,
    );

    // report_send_jobs
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_report_send_jobs_platform_external_exam_date"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_report_send_jobs_psid_exam_date"
      ON "report_send_jobs" ("external_user_id", "exam_date")
    `);
    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" DROP COLUMN "platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" RENAME COLUMN "external_user_id" TO "psid"`,
    );

    // study_reminder_jobs
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_study_reminder_jobs_platform_external_session_key"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_study_reminder_jobs_psid_session_key"
      ON "study_reminder_jobs" ("external_user_id", "session_key")
    `);
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" DROP COLUMN "platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" RENAME COLUMN "external_user_id" TO "psid"`,
    );

    // chat_quota_events -> messenger_chat_events
    await queryRunner.query(
      `ALTER TABLE "chat_quota_events" DROP COLUMN "platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_quota_events" RENAME TO "messenger_chat_events"`,
    );

    // webhook_dead_letters -> messenger_webhook_dead_letters
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_webhook_dead_letter_platform_external"`,
    );
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_webhook_dead_letter_psid"
      ON "webhook_dead_letters" ("external_user_id")
      WHERE "external_user_id" IS NOT NULL
    `);
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" DROP COLUMN "platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" RENAME COLUMN "external_user_id" TO "psid"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" RENAME TO "messenger_webhook_dead_letters"`,
    );

    // scheduled_report_claims -> messenger_scheduled_report_claims
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_scheduled_report_claims_platform_external_date"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_messenger_scheduled_report_claims_psid_date"
      ON "scheduled_report_claims" ("external_user_id", "report_date")
    `);
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" DROP COLUMN "platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" RENAME COLUMN "external_user_id" TO "psid"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" RENAME TO "messenger_scheduled_report_claims"`,
    );

    // message_logs -> messenger_message_logs
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_msg_logs_platform_external_created_at"`,
    );
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_msg_logs_psid_created_at"
      ON "message_logs" ("external_user_id", "created_at" DESC)
    `);
    await queryRunner.query(
      `ALTER TABLE "message_logs" DROP COLUMN "platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_logs" RENAME COLUMN "external_user_id" TO "psid"`,
    );
    await queryRunner.query(
      `ALTER TABLE "message_logs" RENAME TO "messenger_message_logs"`,
    );

    // chat_idempotency -> messenger_chat_idempotency
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_chat_idempotency_platform_external_date"`,
    );
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chat_idempotency_psid_date"
      ON "chat_idempotency" ("external_user_id", "usage_date")
    `);
    await queryRunner.query(
      `ALTER TABLE "chat_idempotency" DROP COLUMN "platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_idempotency" RENAME COLUMN "external_user_id" TO "psid"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_idempotency" RENAME TO "messenger_chat_idempotency"`,
    );

    // chat_daily_usage -> messenger_chat_daily_usage
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_chat_daily_usage_platform_external_date"`,
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_daily_usage_psid_date"
      ON "chat_daily_usage" ("external_user_id", "usage_date")
    `);
    await queryRunner.query(
      `ALTER TABLE "chat_daily_usage" DROP COLUMN "platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_daily_usage" RENAME COLUMN "external_user_id" TO "psid"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_daily_usage" RENAME TO "messenger_chat_daily_usage"`,
    );

    // user_platform_mappings -> user_messenger_mappings
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_platform_mappings_external_status"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_platform_mappings_active_external_unique"`,
    );
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_mappings_psid_status"
      ON "user_platform_mappings" ("external_user_id", "status")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_mappings_active_psid_unique"
      ON "user_platform_mappings" ("external_user_id")
      WHERE status = 'ACTIVE' AND external_user_id IS NOT NULL
    `);
    await queryRunner.query(
      `ALTER TABLE "user_platform_mappings" DROP COLUMN "platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_platform_mappings" RENAME COLUMN "external_user_id" TO "psid"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_platform_mappings" RENAME TO "user_messenger_mappings"`,
    );
  }
}
