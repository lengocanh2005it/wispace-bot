import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds an owner lease for Messenger link completion side effects (#821). */
export class HardenMessengerLinkVerifyLeases1789093400000 implements MigrationInterface {
  name = 'HardenMessengerLinkVerifyLeases1789093400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "messenger_link_verify_records"
        ADD COLUMN IF NOT EXISTS "lease_token" uuid,
        ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamptz
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_messenger_link_verify_processing_lease"
        ON "messenger_link_verify_records" ("status", "lease_expires_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_messenger_link_verify_processing_lease"`,
    );
    await queryRunner.query(`
      ALTER TABLE "messenger_link_verify_records"
        DROP COLUMN IF EXISTS "lease_expires_at",
        DROP COLUMN IF EXISTS "lease_token"
    `);
  }
}
