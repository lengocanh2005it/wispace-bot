import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Replace the partial (status, created_at) index with a composite that
 * includes platform — the cleanup predicate always starts with platform,
 * so the old index forced an extra filter pass.
 */
export class AddDeadLetterCompositeIndex1786920000008 implements MigrationInterface {
  name = 'AddDeadLetterCompositeIndex1786920000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_webhook_dead_letter_platform_status_created"
      ON "webhook_dead_letters" ("platform", "status", "created_at")
    `);

    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_webhook_dead_letter_status_created"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_webhook_dead_letter_platform_status_created"`,
    );

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_webhook_dead_letter_status_created"
      ON "webhook_dead_letters" ("status", "created_at")
    `);
  }
}
