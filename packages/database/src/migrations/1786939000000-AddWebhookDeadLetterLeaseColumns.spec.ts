import type { QueryRunner } from 'typeorm';
import { AddWebhookDeadLetterLeaseColumns1786939000000 } from './1786939000000-AddWebhookDeadLetterLeaseColumns';

describe('AddWebhookDeadLetterLeaseColumns1786939000000', () => {
  const run = async (direction: 'up' | 'down') => {
    const queries: string[] = [];
    const queryRunner = {
      query: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    } as unknown as QueryRunner;

    await new AddWebhookDeadLetterLeaseColumns1786939000000()[direction](
      queryRunner,
    );
    return queries;
  };

  it('adds lease columns and collapses both status checks into one that allows processing', async () => {
    expect(await run('up')).toEqual([
      'ALTER TABLE "webhook_dead_letters" ADD COLUMN IF NOT EXISTS "lease_token" uuid',
      'ALTER TABLE "webhook_dead_letters" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamptz',
      'ALTER TABLE "webhook_dead_letters" DROP CONSTRAINT IF EXISTS "chk_webhook_dead_letter_status"',
      'ALTER TABLE "webhook_dead_letters" DROP CONSTRAINT IF EXISTS "chk_wdl_status"',
      `ALTER TABLE "webhook_dead_letters" ADD CONSTRAINT "chk_wdl_status" CHECK ("status" IN ('pending','processing','replayed','abandoned'))`,
    ]);
  });

  it('restores both narrow status checks and drops the columns on rollback', async () => {
    expect(await run('down')).toEqual([
      'ALTER TABLE "webhook_dead_letters" DROP CONSTRAINT IF EXISTS "chk_wdl_status"',
      `ALTER TABLE "webhook_dead_letters" ADD CONSTRAINT "chk_wdl_status" CHECK ("status" IN ('pending','replayed','abandoned'))`,
      `ALTER TABLE "webhook_dead_letters" ADD CONSTRAINT "chk_webhook_dead_letter_status" CHECK ("status" IN ('pending','replayed','abandoned'))`,
      'ALTER TABLE "webhook_dead_letters" DROP COLUMN IF EXISTS "lease_expires_at"',
      'ALTER TABLE "webhook_dead_letters" DROP COLUMN IF EXISTS "lease_token"',
    ]);
  });
});
