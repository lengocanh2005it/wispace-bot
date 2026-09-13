import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive durable state-cleanup work; no historical requests are backfilled. */
export class CreatePrivacyCleanupJobs1789093700000 implements MigrationInterface {
  name = 'CreatePrivacyCleanupJobs1789093700000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE privacy_cleanup_jobs (
        id bigserial PRIMARY KEY,
        cleanup_id varchar(64) NOT NULL,
        idempotency_key varchar(160) NOT NULL,
        operation varchar(16) NOT NULL,
        platform varchar(16) NOT NULL,
        external_user_id varchar(64) NOT NULL,
        user_id integer NULL,
        mapping_generation varchar(64) NOT NULL,
        store varchar(32) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'pending',
        attempt_count integer NOT NULL DEFAULT 0,
        next_retry_at timestamptz NOT NULL DEFAULT now(),
        lease_token varchar(64) NULL,
        lease_expires_at timestamptz NULL,
        last_error varchar(160) NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz NULL,
        stale_at timestamptz NULL,
        CONSTRAINT uq_privacy_cleanup_jobs_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT privacy_cleanup_jobs_status_check
          CHECK (status IN ('pending', 'processing', 'completed', 'stale')),
        CONSTRAINT privacy_cleanup_jobs_operation_check
          CHECK (operation IN ('unlink', 'delete')),
        CONSTRAINT privacy_cleanup_jobs_store_check
          CHECK (store IN ('chat_history', 'chat_queue', 'clarification_state', 'display_name_cache'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_privacy_cleanup_jobs_cleanup_id
        ON privacy_cleanup_jobs (cleanup_id)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_privacy_cleanup_jobs_due
        ON privacy_cleanup_jobs (platform, status, next_retry_at, lease_expires_at)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_privacy_cleanup_jobs_retention
        ON privacy_cleanup_jobs (status, completed_at, stale_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS idx_privacy_cleanup_jobs_retention',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS idx_privacy_cleanup_jobs_due',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS idx_privacy_cleanup_jobs_cleanup_id',
    );
    await queryRunner.query('DROP TABLE IF EXISTS privacy_cleanup_jobs');
  }
}
