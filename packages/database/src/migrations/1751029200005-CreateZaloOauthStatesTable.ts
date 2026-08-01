import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PKCE code_verifier staging between GET /zalo/oauth/authorize and
 * GET /zalo/oauth/callback (Zalo Login requires PKCE, unlike Discord's
 * OAuth2 — see spec §5.2). TTL (10 min) is enforced by the app's query,
 * not a DB constraint — see ZaloOauthStateService (Task 8).
 */
export class CreateZaloOauthStatesTable1751029200005 implements MigrationInterface {
  name = 'CreateZaloOauthStatesTable1751029200005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "zalo_oauth_states" (
        "state"         character varying(64) PRIMARY KEY,
        "code_verifier" character varying(128) NOT NULL,
        "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "zalo_oauth_states"`);
  }
}
