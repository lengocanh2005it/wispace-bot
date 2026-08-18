import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds owner leases to scheduled report claims. Existing claimed rows remain
 * nullable and are recovered by the stale reset using updated_at as a legacy
 * fallback, so deployment never steals a currently running claim.
 */
export class AddScheduledReportClaimLease1786902000000 implements MigrationInterface {
  name = 'AddScheduledReportClaimLease1786902000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" ADD COLUMN "lease_token" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" ADD COLUMN "lease_expires_at" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" DROP COLUMN "lease_expires_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" DROP COLUMN "lease_token"`,
    );
  }
}
