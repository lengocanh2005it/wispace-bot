import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 1 of #262: Stop persisting raw message bodies in message_logs table.
 *
 * Makes message_text column nullable and nulls all existing rows to purge raw message content.
 * The column itself is retained in phase 1 so that rolling back to an older image remains safe.
 * Phase 2 will drop the column in a subsequent release.
 */
export class NullMessageLogsMessageText1786915000000 implements MigrationInterface {
  name = 'NullMessageLogsMessageText1786915000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'message_logs' AND column_name = 'message_text')`,
    );
    if (hasColumn[0]?.exists) {
      await queryRunner.query(
        `ALTER TABLE "message_logs" ALTER COLUMN "message_text" DROP NOT NULL`,
      );
      await queryRunner.query(
        `UPDATE "message_logs" SET "message_text" = NULL WHERE "message_text" IS NOT NULL`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'message_logs' AND column_name = 'message_text')`,
    );
    if (hasColumn[0]?.exists) {
      await queryRunner.query(
        `UPDATE "message_logs" SET "message_text" = '' WHERE "message_text" IS NULL`,
      );
      await queryRunner.query(
        `ALTER TABLE "message_logs" ALTER COLUMN "message_text" SET NOT NULL`,
      );
    }
  }
}
