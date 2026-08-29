import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWebActivityTable1786934000000 implements MigrationInterface {
  name = 'CreateWebActivityTable1786934000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "web_activity" (
        "user_id" integer NOT NULL,
        "last_active_at" timestamptz NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_web_activity_user_id" PRIMARY KEY ("user_id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "web_activity"`);
  }
}
