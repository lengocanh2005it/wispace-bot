import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the callback-generation and mapping-observation fence used by the
 * shared account-link core. Existing rows cannot be fenced safely because
 * they never stored the observation that preceded verification, so they are
 * retired and require a fresh link token.
 */
export class FenceDiscordZaloLinkVerifyRecords1789093200000 implements MigrationInterface {
  name = 'FenceDiscordZaloLinkVerifyRecords1789093200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DELETE FROM discord_link_verify_records');
    await queryRunner.query('DELETE FROM zalo_link_verify_records');

    for (const table of [
      'discord_link_verify_records',
      'zalo_link_verify_records',
    ]) {
      await queryRunner.query(`
        ALTER TABLE ${table}
          ADD COLUMN intent_generation bigint NOT NULL,
          ADD COLUMN observed_mapping_kind varchar(8) NOT NULL,
          ADD COLUMN observed_mapping_generation bigint NULL,
          ADD CONSTRAINT ${table}_observation_check CHECK (
            (observed_mapping_kind = 'absent' AND observed_mapping_generation IS NULL)
            OR (observed_mapping_kind = 'present' AND observed_mapping_generation IS NOT NULL)
          )
      `);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'zalo_link_verify_records',
      'discord_link_verify_records',
    ]) {
      await queryRunner.query(`
        ALTER TABLE ${table}
          DROP CONSTRAINT ${table}_observation_check,
          DROP COLUMN observed_mapping_generation,
          DROP COLUMN observed_mapping_kind,
          DROP COLUMN intent_generation
      `);
    }
  }
}
