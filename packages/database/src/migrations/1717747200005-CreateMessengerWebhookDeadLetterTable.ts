import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMessengerWebhookDeadLetterTable1717747200005 implements MigrationInterface {
  name = 'CreateMessengerWebhookDeadLetterTable1717747200005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messenger_webhook_dead_letters" (
        "id"            SERIAL NOT NULL,
        "psid"          character varying(64),
        "message_mid"   character varying(255),
        "raw_payload"   JSONB NOT NULL,
        "error_message" TEXT NOT NULL,
        "retry_count"   integer NOT NULL DEFAULT 0,
        "status"        character varying(20) NOT NULL DEFAULT 'pending'
                          CONSTRAINT chk_webhook_dead_letter_status
                          CHECK (status IN ('pending', 'replayed', 'abandoned')),
        "replayed_at"   TIMESTAMPTZ,
        "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_messenger_webhook_dead_letters" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_webhook_dead_letter_status_created"
      ON "messenger_webhook_dead_letters" ("status", "created_at")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_webhook_dead_letter_psid"
      ON "messenger_webhook_dead_letters" ("psid")
      WHERE "psid" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "messenger_webhook_dead_letters"`,
    );
  }
}
