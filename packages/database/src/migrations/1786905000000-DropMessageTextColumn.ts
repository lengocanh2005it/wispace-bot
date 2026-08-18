import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops message_text column from Discord and Zalo message log tables.
 * Full message bodies are PII and should not be persisted in audit logs (#189).
 */
export class DropMessageTextColumn1786905000000 implements MigrationInterface {
  name = 'DropMessageTextColumn1786905000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const discord = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'discord_message_logs' AND column_name = 'message_text')`,
    );
    if (discord[0]?.exists) {
      await queryRunner.query(
        `ALTER TABLE "discord_message_logs" DROP COLUMN "message_text"`,
      );
    }

    const zalo = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'zalo_message_logs' AND column_name = 'message_text')`,
    );
    if (zalo[0]?.exists) {
      await queryRunner.query(
        `ALTER TABLE "zalo_message_logs" DROP COLUMN "message_text"`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "discord_message_logs" ADD COLUMN "message_text" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "zalo_message_logs" ADD COLUMN "message_text" text`,
    );
  }
}
