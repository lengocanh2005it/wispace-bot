import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Atomic linked/organic welcome dedupe state for Zalo (#467). */
export class CreateZaloWelcomeRecordsTable1786940300000 implements MigrationInterface {
  name = 'CreateZaloWelcomeRecordsTable1786940300000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "zalo_welcome_records" (
        "zalo_user_id" character varying(64) NOT NULL,
        "last_welcomed_at" TIMESTAMPTZ NULL,
        "source" character varying(16) NULL,
        "claim_expires_at" TIMESTAMPTZ NULL,
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_zalo_welcome_records" PRIMARY KEY ("zalo_user_id")
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "zalo_welcome_records"');
  }
}
