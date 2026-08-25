import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add (platform, usage_date) index for LLM fleet/date aggregation queries
 * (aggregateFleetByDate, aggregateUsage). The existing indexes on
 * (platform, externalUserId, usageDate) and (feature, usageDate) do not
 * cover the fleet query's WHERE platform = ? AND usage_date = ? predicate.
 */
export class AddLlmUsageFleetIndex1786920000009 implements MigrationInterface {
  name = 'AddLlmUsageFleetIndex1786920000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_llm_usage_platform_usage_date"
      ON "llm_usage_events" ("platform", "usage_date")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_llm_usage_platform_usage_date"`,
    );
  }
}
