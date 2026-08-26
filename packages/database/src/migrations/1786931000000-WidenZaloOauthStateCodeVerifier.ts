import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widens code_verifier from varchar(128) to varchar(512) to accommodate
 * AES-256-GCM encrypted envelope `v1.<iv>.<tag>.<cipher>` at rest (#399).
 */
export class WidenZaloOauthStateCodeVerifier1786931000000 implements MigrationInterface {
  name = 'WidenZaloOauthStateCodeVerifier1786931000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "zalo_oauth_states"
      ALTER COLUMN "code_verifier" TYPE varchar(512)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "zalo_oauth_states"
      ALTER COLUMN "code_verifier" TYPE varchar(128)
    `);
  }
}
