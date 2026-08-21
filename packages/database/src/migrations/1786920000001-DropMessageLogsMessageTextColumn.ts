import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2 of #262: Drop message_text column from message_logs.
 * The column was null'd in migration 1786915000000 and is never written to
 * by application code. The entity has no message_text field.
 */
export class DropMessageLogsMessageTextColumn1786920000001 implements MigrationInterface {
  name = 'DropMessageLogsMessageTextColumn1786920000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'message_logs' AND column_name = 'message_text')`,
    );
    if (hasColumn[0]?.exists) {
      await queryRunner.query(
        `ALTER TABLE "message_logs" DROP COLUMN "message_text"`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasColumn = await queryRunner.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'message_logs' AND column_name = 'message_text')`,
    );
    if (!hasColumn[0]?.exists) {
      await queryRunner.query(
        `ALTER TABLE "message_logs" ADD COLUMN "message_text" text`,
      );
    }
  }
}
