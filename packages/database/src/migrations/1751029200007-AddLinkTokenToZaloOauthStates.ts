import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLinkTokenToZaloOauthStates1751029200007 implements MigrationInterface {
  name = 'AddLinkTokenToZaloOauthStates1751029200007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "zalo_oauth_states"
      ADD COLUMN IF NOT EXISTS "link_token" character varying(512) NOT NULL DEFAULT ''
    `);
    await queryRunner.query(`
      ALTER TABLE "zalo_oauth_states"
      ALTER COLUMN "link_token" DROP DEFAULT
    `);
    await queryRunner.query(`
      ALTER TABLE "zalo_oauth_states"
      ALTER COLUMN "link_token" SET NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "zalo_oauth_states"
      DROP COLUMN IF EXISTS "link_token"
    `);
  }
}
