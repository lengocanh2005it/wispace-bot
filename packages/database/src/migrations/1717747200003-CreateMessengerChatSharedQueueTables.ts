import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMessengerChatSharedQueueTables1717747200003 implements MigrationInterface {
  name = 'CreateMessengerChatSharedQueueTables1717747200003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messenger_chat_queue_buffer" (
        "psid" character varying(64) NOT NULL,
        "user_id" integer,
        "link_context" jsonb,
        "texts" jsonb NOT NULL DEFAULT '[]',
        "pending_texts" jsonb NOT NULL DEFAULT '[]',
        "last_idempotency_key" character varying(128),
        "last_pending_idempotency_key" character varying(128),
        "processing" boolean NOT NULL DEFAULT false,
        "processing_started_at" TIMESTAMPTZ,
        "flush_after_at" TIMESTAMPTZ,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_messenger_chat_queue_buffer" PRIMARY KEY ("psid")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chat_queue_buffer_flush_after"
      ON "messenger_chat_queue_buffer" ("flush_after_at")
      WHERE processing = false AND flush_after_at IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messenger_chat_history" (
        "psid" character varying(64) NOT NULL,
        "messages" jsonb NOT NULL DEFAULT '[]',
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_messenger_chat_history" PRIMARY KEY ("psid")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messenger_chat_webhook_seen" (
        "message_mid" character varying(128) NOT NULL,
        "psid" character varying(64) NOT NULL,
        "seen_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_messenger_chat_webhook_seen" PRIMARY KEY ("message_mid")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chat_webhook_seen_seen_at"
      ON "messenger_chat_webhook_seen" ("seen_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "messenger_chat_webhook_seen"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "messenger_chat_history"`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "messenger_chat_queue_buffer"`,
    );
  }
}
