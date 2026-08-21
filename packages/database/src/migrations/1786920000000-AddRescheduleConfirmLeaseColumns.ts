import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRescheduleConfirmLeaseColumns1786920000000 implements MigrationInterface {
  name = 'AddRescheduleConfirmLeaseColumns1786920000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reschedule_confirmations" ADD COLUMN "lease_token" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "reschedule_confirmations" ADD COLUMN "processing_started_at" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reschedule_confirmations" DROP COLUMN "processing_started_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reschedule_confirmations" DROP COLUMN "lease_token"`,
    );
  }
}
