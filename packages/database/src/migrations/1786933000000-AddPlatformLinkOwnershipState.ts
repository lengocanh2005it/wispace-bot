import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persists canonical WISPACE ownership state separately from Messenger's
 * notification subscription status. Existing rows start active and are
 * revalidated by the platform link reconciliation cron.
 */
export class AddPlatformLinkOwnershipState1786933000000 implements MigrationInterface {
  name = 'AddPlatformLinkOwnershipState1786933000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'user_platform_mappings',
      'discord_account_links',
      'zalo_account_links',
    ]) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN IF NOT EXISTS "link_state" varchar(24) NOT NULL DEFAULT 'active',
          ADD COLUMN IF NOT EXISTS "mapping_generation" bigint NOT NULL DEFAULT 1,
          ADD COLUMN IF NOT EXISTS "last_verified_at" timestamptz NULL,
          ADD COLUMN IF NOT EXISTS "last_unknown_at" timestamptz NULL,
          ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz NULL,
          ADD COLUMN IF NOT EXISTS "revocation_reason" varchar(160) NULL,
          ADD COLUMN IF NOT EXISTS "upstream_ownership_version" varchar(160) NULL
      `);
      if (table !== 'user_platform_mappings') {
        await queryRunner.query(`
          ALTER TABLE "${table}"
            ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now()
        `);
      }
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "idx_${table}_link_state"
          ON "${table}" ("platform", "external_user_id", "link_state")
      `);
      await queryRunner.query(`
        ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "chk_${table}_link_state"
      `);
      await queryRunner.query(`
        ALTER TABLE "${table}" ADD CONSTRAINT "chk_${table}_link_state"
          CHECK ("link_state" IN ('active','confirmed-revoked','temporarily-unknown','locally-unlinked'))
      `);
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "platform_link_audit_events" (
        "id"                  SERIAL PRIMARY KEY,
        "platform"            varchar(16) NOT NULL,
        "external_user_hash"  char(64) NOT NULL,
        "mapping_generation"   bigint NULL,
        "event_type"           varchar(32) NOT NULL,
        "reason"               varchar(160) NULL,
        "ownership_version"    varchar(160) NULL,
        "created_at"           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "chk_platform_link_audit_platform"
          CHECK ("platform" IN ('messenger','discord','zalo')),
        CONSTRAINT "chk_platform_link_audit_event_type"
          CHECK ("event_type" IN ('revoked','unknown','recovered','stale_writer','locally_unlinked'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_platform_link_audit_events_platform_created"
        ON "platform_link_audit_events" ("platform", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_platform_link_audit_events_external_hash"
        ON "platform_link_audit_events" ("platform", "external_user_hash", "event_type", "created_at")
    `);

    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" DROP CONSTRAINT IF EXISTS "chk_rsj_status"`,
    );
    await queryRunner.query(`
      ALTER TABLE "report_send_jobs" ADD CONSTRAINT "chk_rsj_status"
        CHECK ("status" IN ('pending','processing','sent','failed','cancelled'))
    `);
    await queryRunner.query(`
      ALTER TABLE "scheduled_report_claims"
        DROP CONSTRAINT IF EXISTS "chk_src_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "scheduled_report_claims" ADD CONSTRAINT "chk_src_status"
        CHECK ("status" IN ('claimed','sent','released','cancelled'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The legacy status constraints do not allow the newer cancelled state.
    // Normalize rows before restoring them so rollback remains executable.
    await queryRunner.query(
      `UPDATE "report_send_jobs" SET "status" = 'failed' WHERE "status" = 'cancelled'`,
    );
    await queryRunner.query(
      `UPDATE "scheduled_report_claims" SET "status" = 'released' WHERE "status" = 'cancelled'`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_report_claims" DROP CONSTRAINT IF EXISTS "chk_src_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" DROP CONSTRAINT IF EXISTS "chk_rsj_status"`,
    );
    await queryRunner.query(`
      ALTER TABLE "report_send_jobs" ADD CONSTRAINT "chk_rsj_status"
        CHECK ("status" IN ('pending','processing','sent','failed'))
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_platform_link_audit_events_external_hash"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_platform_link_audit_events_platform_created"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "platform_link_audit_events"`,
    );
    for (const table of [
      'user_platform_mappings',
      'discord_account_links',
      'zalo_account_links',
    ]) {
      await queryRunner.query(`DROP INDEX IF EXISTS "idx_${table}_link_state"`);
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "chk_${table}_link_state"`,
      );
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP COLUMN IF EXISTS "upstream_ownership_version",
          DROP COLUMN IF EXISTS "revocation_reason",
          DROP COLUMN IF EXISTS "revoked_at",
          DROP COLUMN IF EXISTS "last_unknown_at",
          DROP COLUMN IF EXISTS "last_verified_at",
          DROP COLUMN IF EXISTS "mapping_generation",
          DROP COLUMN IF EXISTS "link_state"
      `);
      if (table !== 'user_platform_mappings') {
        await queryRunner.query(
          `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "updated_at"`,
        );
      }
    }
  }
}
