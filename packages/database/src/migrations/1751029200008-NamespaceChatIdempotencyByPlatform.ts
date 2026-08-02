import type { MigrationInterface, QueryRunner } from 'typeorm';

export class NamespaceChatIdempotencyByPlatform1751029200008 implements MigrationInterface {
  name = 'NamespaceChatIdempotencyByPlatform1751029200008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chat_idempotency"
      DROP CONSTRAINT IF EXISTS "PK_messenger_chat_idempotency"
    `);
    await queryRunner.query(`
      ALTER TABLE "chat_idempotency"
      DROP CONSTRAINT IF EXISTS "PK_chat_idempotency"
    `);
    await queryRunner.query(`
      ALTER TABLE "chat_idempotency"
      ADD CONSTRAINT "PK_chat_idempotency_platform_key"
      PRIMARY KEY ("platform", "idempotency_key")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_idempotency" DROP CONSTRAINT IF EXISTS "PK_chat_idempotency_platform_key"`,
    );
    await queryRunner.query(`
      ALTER TABLE "chat_idempotency"
      ADD CONSTRAINT "PK_chat_idempotency" PRIMARY KEY ("idempotency_key")
    `);
  }
}
