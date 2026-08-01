import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMessengerIndexes1717747200007 implements MigrationInterface {
  name = 'AddMessengerIndexes1717747200007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // hasSentScheduledReportToday + countMessageLogsByTypeSince per psid
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_msg_logs_psid_created_at"
      ON "messenger_message_logs" ("psid", "created_at" DESC)
    `);

    // countMessageLogsByTypeSince (ops health, META_TOKEN_EXPIRED)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_msg_logs_type_created_at"
      ON "messenger_message_logs" ("message_type", "created_at" DESC)
    `);

    // findActiveMappingByPsid — called on every webhook event
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_mappings_psid_status"
      ON "user_messenger_mappings" ("psid", "status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_mappings_psid_status"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_msg_logs_type_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_msg_logs_psid_created_at"`,
    );
  }
}
