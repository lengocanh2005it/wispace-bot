import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDiscordOauthStatesTable20260821000002 implements MigrationInterface {
  name = 'CreateDiscordOauthStatesTable20260821000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "discord_oauth_states" (
        "state" varchar(64) PRIMARY KEY,
        "link_token" varchar(512) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_discord_oauth_state_created"
      ON "discord_oauth_states" ("created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "discord_oauth_states"`);
  }
}
