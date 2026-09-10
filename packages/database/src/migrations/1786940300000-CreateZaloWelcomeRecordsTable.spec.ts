import type { QueryRunner } from 'typeorm';
import { CreateZaloWelcomeRecordsTable1786940300000 } from './1786940300000-CreateZaloWelcomeRecordsTable';

describe('CreateZaloWelcomeRecordsTable1786940300000', () => {
  it('creates and drops the additive Zalo welcome table', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    } as unknown as QueryRunner;
    const migration = new CreateZaloWelcomeRecordsTable1786940300000();

    await migration.up(queryRunner);
    await migration.down(queryRunner);

    expect(queries[0]).toContain(
      'CREATE TABLE IF NOT EXISTS "zalo_welcome_records"',
    );
    expect(queries[1]).toContain('DROP TABLE IF EXISTS "zalo_welcome_records"');
  });
});
