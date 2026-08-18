import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChatDeliveryFinalizationState1786903000000 implements MigrationInterface {
  name = 'AddChatDeliveryFinalizationState1786903000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_idempotency" DROP CONSTRAINT IF EXISTS "CHK_messenger_chat_idempotency_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_idempotency" ADD CONSTRAINT "CHK_chat_idempotency_status" CHECK ("status" IN ('reserved', 'delivered', 'completed', 'refunded'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "chat_idempotency" SET "status" = 'completed' WHERE "status" = 'delivered'`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_idempotency" DROP CONSTRAINT IF EXISTS "CHK_chat_idempotency_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_idempotency" ADD CONSTRAINT "CHK_messenger_chat_idempotency_status" CHECK ("status" IN ('reserved', 'completed', 'refunded'))`,
    );
  }
}
