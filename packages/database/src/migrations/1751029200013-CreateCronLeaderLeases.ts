import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `cron_leader_leases` — lease-based cron leader election. A static leader
 * (`CRON_LEADER_ENABLED=true` + instance id) that dies previously left the
 * 08:00 report cron dead until an operator intervened; with a lease, another
 * pod takes over once the leader's heartbeat expires.
 */
export class CreateCronLeaderLeases1751029200013 implements MigrationInterface {
  name = 'CreateCronLeaderLeases1751029200013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "cron_leader_leases" (
        "name" varchar(64) PRIMARY KEY,
        "instance_id" varchar(128) NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "cron_leader_leases"`);
  }
}
