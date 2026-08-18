import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds delivery_record column to study_reminder_jobs and scheduled_report_claims.
 * Stores the platform message_id after successful send — on re-claim after crash,
 * a non-null delivery_record means the message was already delivered and should
 * not be re-sent (#181).
 */
export class AddDeliveryRecordColumn1786904000000 implements MigrationInterface {
  name = 'AddDeliveryRecordColumn1786904000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" ADD COLUMN "delivery_record" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" ADD COLUMN "delivery_record" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" DROP COLUMN "delivery_record"`,
    );
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" DROP COLUMN "delivery_record"`,
    );
  }
}
