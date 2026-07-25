import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Single-row store for the Zalo OA server-to-server access_token/refresh_token
 * pair (access_token: 1h, refresh_token: 30 days, single-use — see
 * docs/superpowers/specs/2026-07-20-zalo-bot-mvp-design.md §5.1). Only
 * `apps/messenger-bot` runs migrations (Phase 5 convention); only
 * `apps/zalo-bot` reads/writes this table.
 */
export class CreateZaloOaTokensTable1751029200004 implements MigrationInterface {
  name = 'CreateZaloOaTokensTable1751029200004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "zalo_oa_tokens" (
        "id"                       BIGSERIAL PRIMARY KEY,
        "access_token"             text NOT NULL,
        "refresh_token"            text NOT NULL,
        "access_token_expires_at"  TIMESTAMPTZ NOT NULL,
        "refresh_token_expires_at" TIMESTAMPTZ NOT NULL,
        "updated_at"               TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "zalo_oa_tokens"`);
  }
}
