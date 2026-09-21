import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReportRetryCause1789093900000 implements MigrationInterface {
  name = 'AddReportRetryCause1789093900000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" ADD "retry_cause" character varying(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" ADD CONSTRAINT "chk_report_send_jobs_retry_cause" CHECK ("retry_cause" IS NULL OR "retry_cause" IN ('capacity_overload'))`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" DROP CONSTRAINT "chk_report_send_jobs_retry_cause"`,
    );
    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" DROP COLUMN "retry_cause"`,
    );
  }
}
