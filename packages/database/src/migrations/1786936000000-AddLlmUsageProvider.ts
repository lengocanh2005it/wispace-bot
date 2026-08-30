import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Stores the provider that actually produced each LLM completion. */
export class AddLlmUsageProvider1786936000000 implements MigrationInterface {
  name = 'AddLlmUsageProvider1786936000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "llm_usage_events"
        ADD COLUMN IF NOT EXISTS "provider" varchar(32) NOT NULL DEFAULT 'unknown'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "llm_usage_events"
        DROP COLUMN IF EXISTS "provider"
    `);
  }
}
