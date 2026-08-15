import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Index backing the burst-limit reservation window query
 * (`chat-rate-limit.repository.ts`): counts chat_idempotency rows by
 * (platform, external_user_id) with `reserved_at > burstSince`. The previous
 * indexes lead with platform/status or usage_date, so the time-window count
 * scanned growing historical data inside the reservation transaction.
 */
export class AddBurstLimitReservationIndex1751029200016 implements MigrationInterface {
  name = 'AddBurstLimitReservationIndex1751029200016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_chat_idempotency_platform_external_reserved"
      ON "chat_idempotency" ("platform", "external_user_id", "reserved_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_chat_idempotency_platform_external_reserved"`,
    );
  }
}
