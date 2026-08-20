import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds delivery tracking columns to close crash windows between provider
 * acknowledgement and DB update (#291 dead-letter replay, #294 reminder/report).
 *
 * - delivery_key: stable idempotency key persisted before calling provider
 * - delivery_status: explicit outcome (sent | ambiguous | not_sent)
 * - processing_started_at: marker for lease expiry classification
 *
 * Backfill: existing rows with delivery_record != null → 'sent';
 * rows in 'processing' → 'ambiguous'; everything else stays null.
 */
export class AddOutboundDeliveryOutcomeColumns1786910000000 implements MigrationInterface {
  name = 'AddOutboundDeliveryOutcomeColumns1786910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // webhook_dead_letters
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" ADD COLUMN "delivery_key" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" ADD COLUMN "delivery_status" varchar(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" ADD COLUMN "processing_started_at" timestamptz`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_webhook_dead_letter_delivery_key" ON "webhook_dead_letters" ("delivery_key") WHERE "delivery_key" IS NOT NULL`,
    );

    // Backfill dead letters: delivery_record presence implies sent
    await queryRunner.query(
      `UPDATE "webhook_dead_letters" SET "delivery_status" = 'sent' WHERE "status" = 'replayed'`,
    );

    // study_reminder_jobs
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" ADD COLUMN "delivery_key" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" ADD COLUMN "delivery_status" varchar(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" ADD COLUMN "processing_started_at" timestamptz`,
    );

    // Backfill reminders: delivered (has delivery_record) → sent; processing → ambiguous
    await queryRunner.query(
      `UPDATE "study_reminder_jobs" SET "delivery_status" = 'sent' WHERE "delivery_record" IS NOT NULL`,
    );
    await queryRunner.query(
      `UPDATE "study_reminder_jobs" SET "delivery_status" = 'ambiguous' WHERE "status" = 'processing' AND "delivery_record" IS NULL`,
    );

    // scheduled_report_claims
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" ADD COLUMN "delivery_key" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" ADD COLUMN "delivery_status" varchar(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" ADD COLUMN "processing_started_at" timestamptz`,
    );

    // Backfill reports: sent claims → sent; claimed (processing) with no delivery → ambiguous
    await queryRunner.query(
      `UPDATE "scheduled_report_claims" SET "delivery_status" = 'sent' WHERE "status" = 'sent'`,
    );
    await queryRunner.query(
      `UPDATE "scheduled_report_claims" SET "delivery_status" = 'ambiguous' WHERE "status" = 'claimed' AND "delivery_record" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" DROP COLUMN "processing_started_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" DROP COLUMN "delivery_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" DROP COLUMN "delivery_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" DROP COLUMN "processing_started_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" DROP COLUMN "delivery_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" DROP COLUMN "delivery_key"`,
    );
    await queryRunner.query(
      `DROP INDEX "idx_webhook_dead_letter_delivery_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" DROP COLUMN "processing_started_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" DROP COLUMN "delivery_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" DROP COLUMN "delivery_key"`,
    );
  }
}
