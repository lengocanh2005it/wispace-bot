import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Confirmation buttons must be bound to the exact staged request. Existing
 * rows predate that binding and are intentionally invalidated during rollout.
 */
export class HardenRescheduleConfirmationBinding1786932000000 implements MigrationInterface {
  name = 'HardenRescheduleConfirmationBinding1786932000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "reschedule_confirmations"`);
    await queryRunner.query(
      `ALTER TABLE "reschedule_confirmations"
       ADD COLUMN IF NOT EXISTS "tool_name" varchar(64),
       ADD COLUMN IF NOT EXISTS "platform" varchar(16),
       ADD COLUMN IF NOT EXISTS "mapping_version" varchar(255),
       ADD COLUMN IF NOT EXISTS "intent_hash" varchar(64),
       ADD COLUMN IF NOT EXISTS "args_hash" varchar(64),
       ADD COLUMN IF NOT EXISTS "nonce" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "reschedule_confirmations"
       ALTER COLUMN "tool_name" SET NOT NULL,
       ALTER COLUMN "platform" SET NOT NULL,
       ALTER COLUMN "mapping_version" SET NOT NULL,
       ALTER COLUMN "intent_hash" SET NOT NULL,
       ALTER COLUMN "args_hash" SET NOT NULL,
       ALTER COLUMN "nonce" SET NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_reschedule_confirm_nonce"
       ON "reschedule_confirmations" ("external_id", "nonce")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_reschedule_confirm_nonce"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reschedule_confirmations"
       DROP COLUMN IF EXISTS "nonce",
       DROP COLUMN IF EXISTS "args_hash",
       DROP COLUMN IF EXISTS "intent_hash",
       DROP COLUMN IF EXISTS "mapping_version",
       DROP COLUMN IF EXISTS "platform",
       DROP COLUMN IF EXISTS "tool_name"`,
    );
  }
}
