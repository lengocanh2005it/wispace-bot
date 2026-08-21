import type { QueryRunner } from 'typeorm';
import { AddRescheduleConfirmLeaseColumns1786920000000 } from './1786920000000-AddRescheduleConfirmLeaseColumns';

describe('AddRescheduleConfirmLeaseColumns1786920000000', () => {
  it('uses idempotent column additions for databases migrated under the old name', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    } as unknown as QueryRunner;

    await new AddRescheduleConfirmLeaseColumns1786920000000().up(queryRunner);

    expect(queries).toEqual([
      'ALTER TABLE "reschedule_confirmations" ADD COLUMN IF NOT EXISTS "lease_token" uuid',
      'ALTER TABLE "reschedule_confirmations" ADD COLUMN IF NOT EXISTS "processing_started_at" timestamptz',
    ]);
  });
});
