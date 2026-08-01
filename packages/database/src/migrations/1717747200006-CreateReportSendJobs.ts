import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateReportSendJobs1717747200006 implements MigrationInterface {
  name = 'CreateReportSendJobs1717747200006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "report_send_jobs" (
        "id" SERIAL NOT NULL,
        "psid" character varying(64) NOT NULL,
        "user_id" integer,
        "exam_date" date NOT NULL,
        "first_attempt_date" date NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'pending',
        "retry_count" integer NOT NULL DEFAULT 0,
        "max_retries" integer NOT NULL DEFAULT 3,
        "next_retry_at" TIMESTAMPTZ,
        "last_error" text,
        "sent_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_report_send_jobs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_report_send_jobs_psid_exam_date"
      ON "report_send_jobs" ("psid", "exam_date")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_report_send_jobs_dispatch"
      ON "report_send_jobs" ("status", "next_retry_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "report_send_jobs"`);
  }
}
