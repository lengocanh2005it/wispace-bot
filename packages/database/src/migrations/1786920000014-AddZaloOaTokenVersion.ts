import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add optimistic-lock `version` column to `zalo_oa_tokens` so concurrent
 * refresh attempts can use compare-and-swap (CAS) — a second defense layer
 * on top of the pessimistic row lock (SELECT … FOR UPDATE). Each UPDATE
 * must match `WHERE id = ? AND version = ?`; a stale version means another
 * worker already persisted a new pair and the caller retries.
 */
export class AddZaloOaTokenVersion1786920000014 implements MigrationInterface {
  name = 'AddZaloOaTokenVersion1786920000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "zalo_oa_tokens" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "zalo_oa_tokens" DROP COLUMN IF EXISTS "version"`,
    );
  }
}
