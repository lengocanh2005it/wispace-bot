import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add outbox lease ownership to `study_reminder_jobs` and `report_send_jobs`:
 * - `lease_token` — random UUID assigned at claim time; mark-sent/mark-failed
 *   operations must match it so a stale worker (lease reopened by recovery)
 *   can never overwrite the result of the newer owner.
 * - `lease_expires_at` — deadline for the claim; recovery only reopens
 *   `processing` rows whose lease expired (a live lease is proof the worker
 *   is still active, unlike a bare updated_at timestamp).
 * In-flight `processing` rows at deploy time get a backfilled expiry based on
 * their last update, so the migration never resets a job mid-send.
 */
export class AddJobLeaseColumns1751029200018 implements MigrationInterface {
  name = 'AddJobLeaseColumns1751029200018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" ADD COLUMN "lease_token" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" ADD COLUMN "lease_expires_at" timestamptz`,
    );
    await queryRunner.query(
      `UPDATE "study_reminder_jobs"
       SET "lease_expires_at" = "updated_at" + interval '10 minutes'
       WHERE "status" = 'processing'`,
    );

    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" ADD COLUMN "lease_token" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" ADD COLUMN "lease_expires_at" timestamptz`,
    );
    await queryRunner.query(
      `UPDATE "report_send_jobs"
       SET "lease_expires_at" = "updated_at" + interval '10 minutes'
       WHERE "status" = 'processing'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" DROP COLUMN "lease_expires_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" DROP COLUMN "lease_token"`,
    );
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" DROP COLUMN "lease_expires_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" DROP COLUMN "lease_token"`,
    );
  }
}
