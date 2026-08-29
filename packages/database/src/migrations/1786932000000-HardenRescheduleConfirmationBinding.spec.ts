import type { QueryRunner } from 'typeorm';
import { HardenRescheduleConfirmationBinding1786932000000 } from './1786932000000-HardenRescheduleConfirmationBinding';

describe('HardenRescheduleConfirmationBinding1786932000000', () => {
  it('invalidates legacy rows before requiring approval binding columns', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    } as unknown as QueryRunner;

    await new HardenRescheduleConfirmationBinding1786932000000().up(
      queryRunner,
    );

    expect(queries[0]).toContain('DELETE FROM "reschedule_confirmations"');
    expect(queries[1]).toContain('ADD COLUMN IF NOT EXISTS "nonce" uuid');
    expect(queries[2]).toContain('"nonce" SET NOT NULL');
    expect(queries[3]).toContain('"external_id", "nonce"');
  });
});
