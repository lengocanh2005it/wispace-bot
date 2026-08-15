import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Index backing the stale-processing lease recovery in the inbound retry
 * cron (`listDue`'s `status='processing' AND updated_at < staleBefore`
 * predicate). The existing due index covers (platform, status, next_retry_at)
 * only, so the stale scan fell back to a sequential read of the platform's
 * events.
 */
export class AddWebhookInboundStaleIndex1751029200017 implements MigrationInterface {
  name = 'AddWebhookInboundStaleIndex1751029200017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_webhook_inbound_events_stale"
      ON "webhook_inbound_events" ("platform", "status", "updated_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_webhook_inbound_events_stale"`,
    );
  }
}
