import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUpdatedAtToChatIdempotency1751029200009 implements MigrationInterface {
  name = 'AddUpdatedAtToChatIdempotency1751029200009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chat_idempotency"
      ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chat_idempotency"
      DROP COLUMN "updated_at"
    `);
  }
}
