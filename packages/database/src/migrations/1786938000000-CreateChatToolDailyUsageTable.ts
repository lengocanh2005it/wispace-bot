import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-user write-tool budget (#626): daily counter for mutating LLM tool
 * calls (`reschedule_study_session`, `precreate_next_exercise`). Keyed on
 * the resolved WISPACE `user_id`; `external_user_id` kept for ops debugging.
 */
export class CreateChatToolDailyUsageTable1786938000000 implements MigrationInterface {
  name = 'CreateChatToolDailyUsageTable1786938000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chat_tool_daily_usage" (
        "id" SERIAL PRIMARY KEY,
        "platform" varchar(16) NOT NULL DEFAULT 'messenger',
        "external_user_id" varchar(64) NOT NULL,
        "user_id" int NOT NULL,
        "usage_date" date NOT NULL,
        "tool_name" varchar(64) NOT NULL,
        "count" int NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_tool_daily_usage"
      ON "chat_tool_daily_usage" ("platform", "user_id", "usage_date", "tool_name")
    `);
    await queryRunner.query(`
      COMMENT ON TABLE "chat_tool_daily_usage" IS
        'Per-user per-day mutating-tool call budget (#626)'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_chat_tool_daily_usage"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chat_tool_daily_usage"`);
  }
}
