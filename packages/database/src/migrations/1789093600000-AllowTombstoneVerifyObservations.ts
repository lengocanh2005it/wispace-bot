import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Allows an absent verify observation to carry the privacy-unlink tombstone
 * generation used by the callback compare-and-set fence.
 */
export class AllowTombstoneVerifyObservations1789093600000 implements MigrationInterface {
  name = 'AllowTombstoneVerifyObservations1789093600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'discord_link_verify_records',
      'zalo_link_verify_records',
    ]) {
      await queryRunner.query(`
        ALTER TABLE ${table}
          DROP CONSTRAINT ${table}_observation_check,
          ADD CONSTRAINT ${table}_observation_check CHECK (
            observed_mapping_kind = 'absent'
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
          ADD CONSTRAINT ${table}_observation_check CHECK (
            (observed_mapping_kind = 'absent' AND observed_mapping_generation IS NULL)
            OR (observed_mapping_kind = 'present' AND observed_mapping_generation IS NOT NULL)
          )
      `);
    }
  }
}
