import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Index backing the webhook-inbound retention cleanup:
 * `webhook_inbound_events (platform, status, created_at)` — the daily
 * cleanup cron DELETEs terminal (`completed`/`abandoned`) raw payload rows
 * older than the retention window per platform.
 */
export class AddWebhookInboundCleanupIndex1751029200015 implements MigrationInterface {
  name = 'AddWebhookInboundCleanupIndex1751029200015';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_webhook_inbound_events_cleanup"
      ON "webhook_inbound_events" ("platform", "status", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_webhook_inbound_events_cleanup"`,
    );
  }
}
