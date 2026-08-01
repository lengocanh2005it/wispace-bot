import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds cached_tokens to llm_usage_events — tracks tokens served from
 * OpenAI's automatic prompt cache (subset of prompt_tokens), so cost
 * estimates can apply the cheaper cached-input price.
 */
export class AddLlmUsageEventsCachedTokens1751029200003 implements MigrationInterface {
  name = 'AddLlmUsageEventsCachedTokens1751029200003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "llm_usage_events"
      ADD COLUMN IF NOT EXISTS "cached_tokens" integer NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "llm_usage_events"
      DROP COLUMN IF EXISTS "cached_tokens"
    `);
  }
}
