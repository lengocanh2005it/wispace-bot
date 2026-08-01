import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMessengerChatRateLimitTables1717747200002 implements MigrationInterface {
  name = 'CreateMessengerChatRateLimitTables1717747200002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messenger_chat_daily_usage" (
        "id" SERIAL NOT NULL,
        "psid" character varying(64) NOT NULL,
        "user_id" integer,
        "usage_date" DATE NOT NULL,
        "free_form_count" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_messenger_chat_daily_usage" PRIMARY KEY ("id"),
        CONSTRAINT "uq_chat_daily_usage_psid_date" UNIQUE ("psid", "usage_date")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chat_daily_usage_user_date"
      ON "messenger_chat_daily_usage" ("user_id", "usage_date")
      WHERE "user_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messenger_chat_idempotency" (
        "idempotency_key" character varying(128) NOT NULL,
        "psid" character varying(64) NOT NULL,
        "user_id" integer,
        "usage_date" DATE NOT NULL,
        "reserved_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "status" character varying(16) NOT NULL DEFAULT 'reserved',
        CONSTRAINT "PK_messenger_chat_idempotency" PRIMARY KEY ("idempotency_key"),
        CONSTRAINT "CHK_messenger_chat_idempotency_status"
          CHECK ("status" IN ('reserved', 'completed', 'refunded'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chat_idempotency_psid_date"
      ON "messenger_chat_idempotency" ("psid", "usage_date")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "messenger_chat_idempotency"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "messenger_chat_daily_usage"`,
    );
  }
}
