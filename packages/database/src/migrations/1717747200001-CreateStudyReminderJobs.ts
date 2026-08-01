import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateStudyReminderJobs1717747200001 implements MigrationInterface {
  name = 'CreateStudyReminderJobs1717747200001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "study_reminder_jobs" (
        "id" SERIAL NOT NULL,
        "psid" character varying(64) NOT NULL,
        "user_id" integer,
        "session_key" character varying(128) NOT NULL,
        "scheduled_at" TIMESTAMPTZ NOT NULL,
        "remind_at" TIMESTAMPTZ NOT NULL,
        "topic" character varying(255),
        "status" character varying(20) NOT NULL DEFAULT 'pending',
        "retry_count" integer NOT NULL DEFAULT 0,
        "max_retries" integer NOT NULL DEFAULT 3,
        "next_retry_at" TIMESTAMPTZ,
        "last_error" text,
        "sent_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_study_reminder_jobs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_study_reminder_jobs_psid_session_key"
      ON "study_reminder_jobs" ("psid", "session_key")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_study_reminder_jobs_dispatch"
      ON "study_reminder_jobs" ("status", "remind_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "study_reminder_jobs"`);
  }
}
