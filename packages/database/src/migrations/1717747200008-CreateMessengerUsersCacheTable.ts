import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMessengerUsersCacheTable1717747200008 implements MigrationInterface {
  name = 'CreateMessengerUsersCacheTable1717747200008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id integer NOT NULL,
        display_name text,
        exam_date timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users" PRIMARY KEY (user_id)
      )
    `);

    await queryRunner.query(`
      CREATE OR REPLACE VIEW "Users" AS
      SELECT
        user_id AS "Id",
        display_name AS "DisplayName",
        exam_date AS "ExamDate",
        NULL::numeric AS "TargetScore",
        NULL::varchar AS "Username"
      FROM users
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP VIEW IF EXISTS "Users"`);
    await queryRunner.query(`DROP TABLE IF EXISTS users`);
  }
}
