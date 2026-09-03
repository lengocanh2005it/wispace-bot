import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Completes the crash-safe dead-letter replay schema (#711). The replay path
 * (#291) has always driven `webhook_dead_letters` through `status = 'processing'`
 * under an owner lease (`lease_token` / `lease_expires_at`) in
 * `PlatformDeadLetterService`, but three pieces of that schema never shipped:
 *
 *  1. `1786910000000` added `delivery_key` / `delivery_status` /
 *     `processing_started_at` but NOT the lease columns — so `claimForRetry`
 *     threw `column "lease_token" does not exist` on the first pending outbound
 *     row.
 *  2. The original CREATE TABLE (`1717747200005`) attached an inline
 *     `chk_webhook_dead_letter_status` check as `IN ('pending','replayed',
 *     'abandoned')`.
 *  3. `1786920000003` then added a SECOND status check, `chk_wdl_status`, with
 *     the same missing `'processing'` value.
 *
 * Net effect: the retry cron in all three bots was silently disabled the moment
 * any outbound send dead-lettered. This migration adds the columns and
 * collapses the two status checks into one `chk_wdl_status` that allows
 * `'processing'` (matching every other leased table).
 *
 * Lease columns mirror `AddJobLeaseColumns1751029200018`; both nullable, no
 * backfill (no `processing` row can exist — `claimForRetry` never succeeded).
 * All statements are guarded (`IF [NOT] EXISTS` / `DROP CONSTRAINT IF EXISTS`):
 * production code has referenced this schema for months, so an operator may
 * have hand-patched it before this lands.
 */
export class AddWebhookDeadLetterLeaseColumns1786939000000 implements MigrationInterface {
  name = 'AddWebhookDeadLetterLeaseColumns1786939000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" ADD COLUMN IF NOT EXISTS "lease_token" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamptz`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" DROP CONSTRAINT IF EXISTS "chk_webhook_dead_letter_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" DROP CONSTRAINT IF EXISTS "chk_wdl_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" ADD CONSTRAINT "chk_wdl_status" CHECK ("status" IN ('pending','processing','replayed','abandoned'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" DROP CONSTRAINT IF EXISTS "chk_wdl_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" ADD CONSTRAINT "chk_wdl_status" CHECK ("status" IN ('pending','replayed','abandoned'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" ADD CONSTRAINT "chk_webhook_dead_letter_status" CHECK ("status" IN ('pending','replayed','abandoned'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" DROP COLUMN IF EXISTS "lease_expires_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" DROP COLUMN IF EXISTS "lease_token"`,
    );
  }
}
