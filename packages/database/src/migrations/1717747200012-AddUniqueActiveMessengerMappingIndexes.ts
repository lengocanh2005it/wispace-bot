import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUniqueActiveMessengerMappingIndexes1717747200012 implements MigrationInterface {
  name = 'AddUniqueActiveMessengerMappingIndexes1717747200012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH keepers AS (
        SELECT DISTINCT ON (psid) id
        FROM user_messenger_mappings
        WHERE status = 'ACTIVE' AND psid IS NOT NULL
        ORDER BY psid, id DESC
      )
      UPDATE user_messenger_mappings
      SET status = 'INACTIVE', updated_at = now()
      WHERE status = 'ACTIVE'
        AND psid IS NOT NULL
        AND id NOT IN (SELECT id FROM keepers)
    `);

    await queryRunner.query(`
      WITH keepers AS (
        SELECT DISTINCT ON (user_id) id
        FROM user_messenger_mappings
        WHERE status = 'ACTIVE' AND user_id IS NOT NULL
        ORDER BY user_id, id DESC
      )
      UPDATE user_messenger_mappings
      SET status = 'INACTIVE', updated_at = now()
      WHERE status = 'ACTIVE'
        AND user_id IS NOT NULL
        AND id NOT IN (SELECT id FROM keepers)
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_mappings_active_psid_unique"
      ON "user_messenger_mappings" ("psid")
      WHERE status = 'ACTIVE' AND psid IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_mappings_active_user_id_unique"
      ON "user_messenger_mappings" ("user_id")
      WHERE status = 'ACTIVE' AND user_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_mappings_active_user_id_unique"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_mappings_active_psid_unique"`,
    );
  }
}
