import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Webhook-inbox lease ownership (#149): a claim token assigned when the
 * retry worker claims a row (`processing`). Completion/failure/abandon
 * transitions require the token, so a worker whose lease was stale-recovered
 * can never overwrite the terminal state.
 */
export class AddWebhookInboundLeaseToken1786869155627 implements MigrationInterface {
  name = 'AddWebhookInboundLeaseToken1786869155627';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_inbound_events" ADD COLUMN IF NOT EXISTS "lease_token" varchar(64)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_inbound_events" DROP COLUMN IF EXISTS "lease_token"`,
    );
  }
}
