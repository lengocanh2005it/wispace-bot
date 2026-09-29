import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #1418 — durable record of an attempted reschedule mutation. The staged
 * request row is a single slot per learner and its save path overwrites
 * whatever is there, so it cannot also carry the proof that a calendar write
 * committed.
 *
 * Additive only: no existing table is touched.
 */
export class AddRescheduleConfirmationAttempts1789094000000 implements MigrationInterface {
  name = 'AddRescheduleConfirmationAttempts1789094000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "reschedule_confirmation_attempts" (
         "id" SERIAL NOT NULL,
         "platform" character varying(16) NOT NULL,
         "external_id" character varying(128) NOT NULL,
         "nonce" uuid NOT NULL,
         "user_id" integer NOT NULL,
         "status" character varying(16) NOT NULL DEFAULT 'attempting',
         "scheduled_time_label" character varying(255),
         "notification_status" character varying(16) NOT NULL DEFAULT 'pending',
         "notification_attempts" integer NOT NULL DEFAULT 0,
         "next_notification_attempt_at" TIMESTAMP WITH TIME ZONE,
         "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "chk_reschedule_attempt_status" CHECK ("status" IN ('attempting', 'confirmed')),
         CONSTRAINT "chk_reschedule_attempt_notification_status" CHECK (
           "notification_status" IN ('pending', 'deferred', 'delivered', 'ambiguous', 'abandoned')
         ),
         CONSTRAINT "pk_reschedule_confirmation_attempts" PRIMARY KEY ("id")
       )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_reschedule_attempt_identity_unique" ON "reschedule_confirmation_attempts" ("platform", "external_id", "nonce")`,
    );
    // The recovery cron scans for a confirmed attempt whose confirmation is
    // deferred and due; it must not scan the whole table.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_reschedule_attempt_notification_due" ON "reschedule_confirmation_attempts" ("status", "notification_status", "next_notification_attempt_at")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_reschedule_attempt_notification_due"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_reschedule_attempt_identity_unique"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "reschedule_confirmation_attempts"`,
    );
  }
}
