import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMessengerScheduledReportClaims1717747200004 implements MigrationInterface {
  name = 'CreateMessengerScheduledReportClaims1717747200004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messenger_scheduled_report_claims" (
        "id" SERIAL NOT NULL,
        "psid" character varying(64) NOT NULL,
        "report_date" date NOT NULL,
        "user_id" integer,
        "status" character varying(20) NOT NULL DEFAULT 'claimed',
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_messenger_scheduled_report_claims" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_messenger_scheduled_report_claims_psid_date"
      ON "messenger_scheduled_report_claims" ("psid", "report_date")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS "messenger_scheduled_report_claims"
    `);
  }
}
