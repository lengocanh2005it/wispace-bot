import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Supports the recurring delete of expired Zalo OAuth PKCE state rows. */
export class AddZaloOauthStateCleanupIndex1751029200016 implements MigrationInterface {
  name = 'AddZaloOauthStateCleanupIndex1751029200016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_zalo_oauth_states_created_at"
      ON "zalo_oauth_states" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_zalo_oauth_states_created_at"`,
    );
  }
}
