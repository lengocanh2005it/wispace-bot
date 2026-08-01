import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropMessengerChatWebhookSeenTable1717747200009 implements MigrationInterface {
  name = 'DropMessengerChatWebhookSeenTable1717747200009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "messenger_chat_webhook_seen"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
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
}
