import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUserNotificationPreferencesTable1786930000000 implements MigrationInterface {
  name = 'CreateUserNotificationPreferencesTable1786930000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_notification_preferences" (
        "user_id" integer PRIMARY KEY,
        "preferred_platform" varchar(16),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "user_notification_preferences"`,
    );
  }
}
