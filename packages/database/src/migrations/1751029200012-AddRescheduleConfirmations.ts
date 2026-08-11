import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `reschedule_confirmations` — persisted pending reschedule confirmations
 * shared by all 3 bots. Replaces the per-instance in-memory Map so a restart
 * or another pod does not lose a staged confirmation.
 */
export class AddRescheduleConfirmations1751029200012 implements MigrationInterface {
  name = 'AddRescheduleConfirmations1751029200012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reschedule_confirmations" (
        "id" SERIAL PRIMARY KEY,
        "external_id" varchar(128) NOT NULL,
        "user_id" integer NOT NULL,
        "calendar_id" integer NOT NULL,
        "scheduling_mode" varchar(32) NOT NULL,
        "new_local_date" varchar(20),
        "new_time" varchar(10),
        "session_label" varchar(255) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'pending',
        "expires_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_reschedule_confirm_external_unique"
      ON "reschedule_confirmations" ("external_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_reschedule_confirm_external_status"
      ON "reschedule_confirmations" ("external_id", "status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "reschedule_confirmations"`);
  }
}
