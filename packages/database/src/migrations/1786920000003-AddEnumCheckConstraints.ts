import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds CHECK constraints for all state-machine enum columns (#295).
 * Validates existing rows first — fails if invalid data is found.
 */
export class AddEnumCheckConstraints1786920000003 implements MigrationInterface {
  name = 'AddEnumCheckConstraints1786920000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Validate no invalid rows exist before adding constraints
    await this.validate(queryRunner);

    // webhook_inbound_events
    await queryRunner.query(`
      ALTER TABLE "webhook_inbound_events"
      ADD CONSTRAINT "chk_wie_status"
      CHECK ("status" IN ('pending','processing','completed','failed','abandoned'))
    `);
    await queryRunner.query(`
      ALTER TABLE "webhook_inbound_events"
      ADD CONSTRAINT "chk_wie_platform"
      CHECK ("platform" IN ('messenger','discord','zalo'))
    `);

    // study_reminder_jobs
    await queryRunner.query(`
      ALTER TABLE "study_reminder_jobs"
      ADD CONSTRAINT "chk_srr_status"
      CHECK ("status" IN ('pending','processing','sent','failed','cancelled'))
    `);
    await queryRunner.query(`
      ALTER TABLE "study_reminder_jobs"
      ADD CONSTRAINT "chk_srr_platform"
      CHECK ("platform" IN ('messenger','discord','zalo'))
    `);

    // report_send_jobs
    await queryRunner.query(`
      ALTER TABLE "report_send_jobs"
      ADD CONSTRAINT "chk_rsj_status"
      CHECK ("status" IN ('pending','processing','sent','failed'))
    `);
    await queryRunner.query(`
      ALTER TABLE "report_send_jobs"
      ADD CONSTRAINT "chk_rsj_platform"
      CHECK ("platform" IN ('messenger','discord','zalo'))
    `);

    // webhook_dead_letters
    await queryRunner.query(`
      ALTER TABLE "webhook_dead_letters"
      ADD CONSTRAINT "chk_wdl_status"
      CHECK ("status" IN ('pending','replayed','abandoned'))
    `);
    await queryRunner.query(`
      ALTER TABLE "webhook_dead_letters"
      ADD CONSTRAINT "chk_wdl_direction"
      CHECK ("direction" IN ('inbound','outbound'))
    `);
    await queryRunner.query(`
      ALTER TABLE "webhook_dead_letters"
      ADD CONSTRAINT "chk_wdl_platform"
      CHECK ("platform" IN ('messenger','discord','zalo'))
    `);

    // chat_idempotency
    await queryRunner.query(`
      ALTER TABLE "chat_idempotency"
      ADD CONSTRAINT "chk_ci_status"
      CHECK ("status" IN ('reserved','delivered','completed','refunded'))
    `);
    await queryRunner.query(`
      ALTER TABLE "chat_idempotency"
      ADD CONSTRAINT "chk_ci_platform"
      CHECK ("platform" IN ('messenger','discord','zalo'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_idempotency" DROP CONSTRAINT IF EXISTS "chk_ci_platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "chat_idempotency" DROP CONSTRAINT IF EXISTS "chk_ci_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" DROP CONSTRAINT IF EXISTS "chk_wdl_platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" DROP CONSTRAINT IF EXISTS "chk_wdl_direction"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_dead_letters" DROP CONSTRAINT IF EXISTS "chk_wdl_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" DROP CONSTRAINT IF EXISTS "chk_rsj_platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "report_send_jobs" DROP CONSTRAINT IF EXISTS "chk_rsj_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" DROP CONSTRAINT IF EXISTS "chk_srr_platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "study_reminder_jobs" DROP CONSTRAINT IF EXISTS "chk_srr_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_inbound_events" DROP CONSTRAINT IF EXISTS "chk_wie_platform"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_inbound_events" DROP CONSTRAINT IF EXISTS "chk_wie_status"`,
    );
  }

  private async validate(queryRunner: QueryRunner): Promise<void> {
    const checks = [
      {
        table: 'webhook_inbound_events',
        column: 'status',
        values: "'pending','processing','completed','failed','abandoned'",
      },
      {
        table: 'webhook_inbound_events',
        column: 'platform',
        values: "'messenger','discord','zalo'",
      },
      {
        table: 'study_reminder_jobs',
        column: 'status',
        values: "'pending','processing','sent','failed','cancelled'",
      },
      {
        table: 'study_reminder_jobs',
        column: 'platform',
        values: "'messenger','discord','zalo'",
      },
      {
        table: 'report_send_jobs',
        column: 'status',
        values: "'pending','processing','sent','failed'",
      },
      {
        table: 'report_send_jobs',
        column: 'platform',
        values: "'messenger','discord','zalo'",
      },
      {
        table: 'webhook_dead_letters',
        column: 'status',
        values: "'pending','replayed','abandoned'",
      },
      {
        table: 'webhook_dead_letters',
        column: 'direction',
        values: "'inbound','outbound'",
      },
      {
        table: 'webhook_dead_letters',
        column: 'platform',
        values: "'messenger','discord','zalo'",
      },
      {
        table: 'chat_idempotency',
        column: 'status',
        values: "'reserved','delivered','completed','refunded'",
      },
      {
        table: 'chat_idempotency',
        column: 'platform',
        values: "'messenger','discord','zalo'",
      },
    ];

    for (const { table, column, values } of checks) {
      const rows: Array<{ invalid: string }> = await queryRunner.query(
        `SELECT DISTINCT "${column}" AS invalid FROM "${table}" WHERE "${column}" NOT IN (${values})`,
      );
      if (rows.length > 0) {
        const invalidValues = rows.map((r) => r.invalid).join(', ');
        throw new Error(
          `Migration blocked: ${table}.${column} has invalid values: ${invalidValues}. Clean data before applying CHECK constraint.`,
        );
      }
    }
  }
}
