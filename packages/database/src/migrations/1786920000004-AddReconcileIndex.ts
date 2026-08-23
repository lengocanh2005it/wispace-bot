import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReconcileIndex1786920000004 implements MigrationInterface {
  name = 'AddReconcileIndex1786920000004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_discord_link_verify_stale" ON "discord_link_verify_records" ("verified_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_zalo_link_verify_stale" ON "zalo_link_verify_records" ("verified_at")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_discord_link_verify_stale"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_zalo_link_verify_stale"`,
    );
  }
}
