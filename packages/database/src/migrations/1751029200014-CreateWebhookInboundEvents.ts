import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `webhook_inbound_events` — durable inbox for authenticated inbound
 * webhook events. The webhook endpoints persist an event here before
 * acknowledging it (200), so a crash or handler failure can never lose an
 * event: the inbound retry cron replays `pending`/`failed` rows with bounded
 * backoff until `completed` or `abandoned` (terminal). The unique
 * `(platform, event_id)` constraint makes duplicate deliveries idempotent.
 */
export class CreateWebhookInboundEvents1751029200014 implements MigrationInterface {
  name = 'CreateWebhookInboundEvents1751029200014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "webhook_inbound_events" (
        "id" SERIAL NOT NULL,
        "platform" varchar(16) NOT NULL,
        "event_id" varchar(255) NOT NULL,
        "external_user_id" varchar(64),
        "event_type" varchar(32),
        "raw_payload" jsonb NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "retry_count" integer NOT NULL DEFAULT 0,
        "last_error" text,
        "next_retry_at" timestamptz,
        "processed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_inbound_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_webhook_inbound_events_platform_event_id"
      ON "webhook_inbound_events" ("platform", "event_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_webhook_inbound_events_status_due"
      ON "webhook_inbound_events" ("platform", "status", "next_retry_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "webhook_inbound_events"`);
  }
}
