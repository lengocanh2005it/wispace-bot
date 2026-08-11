import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `webhook_dead_letters.direction` — distinguishes inbound webhook events
 * ('inbound', the default) from outbound send failures ('outbound').
 * The shared Discord/Zalo retry cron only replays 'outbound' entries:
 * replaying an inbound event via `sendText` used to echo the user's own
 * text back at them.
 */
export class AddDeadLetterDirection1751029200011 implements MigrationInterface {
  name = 'AddDeadLetterDirection1751029200011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "webhook_dead_letters"
      ADD COLUMN IF NOT EXISTS "direction" varchar(10) NOT NULL DEFAULT 'inbound'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "webhook_dead_letters" DROP COLUMN IF EXISTS "direction"
    `);
  }
}
