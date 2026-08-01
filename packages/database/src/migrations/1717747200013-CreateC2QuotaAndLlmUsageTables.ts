import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateC2QuotaAndLlmUsageTables1717747200013 implements MigrationInterface {
  name = 'CreateC2QuotaAndLlmUsageTables1717747200013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messenger_chat_events" (
        "id" BIGSERIAL NOT NULL,
        "aggregate_id" character varying(64) NOT NULL,
        "aggregate_type" character varying(32) NOT NULL DEFAULT 'chat_quota',
        "event_type" character varying(64) NOT NULL,
        "payload" JSONB NOT NULL DEFAULT '{}',
        "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "usage_date" DATE NOT NULL,
        "user_id" integer,
        "idempotency_key" character varying(128),
        CONSTRAINT "PK_messenger_chat_events" PRIMARY KEY ("id"),
        CONSTRAINT "uq_chat_events_idempotency" UNIQUE ("idempotency_key")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chat_events_aggregate_time"
      ON "messenger_chat_events" ("aggregate_id", "occurred_at")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chat_events_usage_date"
      ON "messenger_chat_events" ("usage_date", "event_type")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "llm_usage_events" (
        "id" BIGSERIAL NOT NULL,
        "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "usage_date" DATE NOT NULL,
        "feature" character varying(32) NOT NULL,
        "psid" character varying(64),
        "user_id" integer,
        "model" character varying(64) NOT NULL,
        "prompt_tokens" integer NOT NULL DEFAULT 0,
        "completion_tokens" integer NOT NULL DEFAULT 0,
        "total_tokens" integer NOT NULL DEFAULT 0,
        "openai_response_id" character varying(128),
        "correlation_id" character varying(128),
        "tool_round" smallint,
        "status" character varying(16) NOT NULL DEFAULT 'ok',
        "error_message" text,
        "estimated_cost_usd" numeric(12, 6),
        CONSTRAINT "PK_llm_usage_events" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_llm_usage_user_date"
      ON "llm_usage_events" ("user_id", "usage_date")
      WHERE "user_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_llm_usage_psid_date"
      ON "llm_usage_events" ("psid", "usage_date")
      WHERE "psid" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_llm_usage_feature_date"
      ON "llm_usage_events" ("feature", "usage_date")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "llm_usage_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "messenger_chat_events"`);
  }
}
