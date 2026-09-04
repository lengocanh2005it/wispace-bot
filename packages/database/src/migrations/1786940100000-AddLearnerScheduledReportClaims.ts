import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #637: scheduled-report idempotency is learner-scoped. The existing
 * scheduled_report_claims table remains the per-platform audit/outbox record;
 * this table is the correctness boundary for one learner/date/report type.
 */
export class AddLearnerScheduledReportClaims1786940100000 implements MigrationInterface {
  name = 'AddLearnerScheduledReportClaims1786940100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "learner_scheduled_report_claims" (
        "id" SERIAL NOT NULL,
        "user_id" integer NOT NULL,
        "report_date" date NOT NULL,
        "report_type" character varying(32) NOT NULL DEFAULT 'scheduled',
        "platform" character varying(16) NOT NULL,
        "external_user_id" character varying(64) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'claimed',
        "lease_token" uuid,
        "lease_expires_at" TIMESTAMPTZ,
        "delivery_record" text,
        "delivery_key" text,
        "delivery_status" character varying(20),
        "processing_started_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_learner_scheduled_report_claims" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "uq_learner_scheduled_report_claims_user_date_type"
      ON "learner_scheduled_report_claims"
        ("user_id", "report_date", "report_type")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_learner_scheduled_report_claims_status_lease"
      ON "learner_scheduled_report_claims" ("status", "lease_expires_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_learner_scheduled_report_claims_created_at"
      ON "learner_scheduled_report_claims" ("created_at")
    `);

    // Preserve existing sent/active per-link claims during rollout. A sent
    // claim wins over an active claim, which wins over a released row.
    await queryRunner.query(`
      INSERT INTO "learner_scheduled_report_claims" (
        "user_id", "report_date", "report_type", "platform",
        "external_user_id", "status", "lease_token", "lease_expires_at",
        "delivery_record", "delivery_key", "delivery_status",
        "processing_started_at", "created_at", "updated_at"
      )
      SELECT DISTINCT ON ("user_id", "report_date")
        "user_id", "report_date", 'scheduled', "platform",
        "external_user_id", "status", "lease_token", "lease_expires_at",
        "delivery_record", "delivery_key", "delivery_status",
        "processing_started_at", "created_at", "updated_at"
      FROM "scheduled_report_claims"
      WHERE "user_id" IS NOT NULL
        AND "status" IN ('sent', 'claimed', 'released')
      ORDER BY "user_id", "report_date",
        CASE "status" WHEN 'sent' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END,
        "updated_at" DESC
      ON CONFLICT ("user_id", "report_date", "report_type") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "learner_scheduled_report_claims"`,
    );
  }
}
