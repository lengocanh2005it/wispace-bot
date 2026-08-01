import { MigrationInterface, QueryRunner } from 'typeorm';

export class TrimUsersCacheToMessengerMappings1717747200011 implements MigrationInterface {
  name = 'TrimUsersCacheToMessengerMappings1717747200011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM users u
      WHERE NOT EXISTS (
        SELECT 1
        FROM user_messenger_mappings m
        WHERE m.user_id = u.user_id
      )
    `);
  }

  public async down(): Promise<void> {
    // Data-only trim — cannot restore deleted Wispace snapshot rows.
  }
}
