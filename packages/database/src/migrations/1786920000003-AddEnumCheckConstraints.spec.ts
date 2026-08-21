import type { QueryRunner } from 'typeorm';
import { AddEnumCheckConstraints1786920000003 } from './1786920000003-AddEnumCheckConstraints';

describe('AddEnumCheckConstraints1786920000003', () => {
  it('skips constraints already created by the old migration name', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: async (sql: string) => {
        queries.push(sql);
        return sql.includes('pg_constraint') ? [{}] : [];
      },
    } as unknown as QueryRunner;

    await new AddEnumCheckConstraints1786920000003().up(queryRunner);

    expect(queries.some((sql) => sql.includes('ADD CONSTRAINT'))).toBe(false);
  });
});
