import type { QueryRunner } from 'typeorm';
import { WidenZaloOauthStateCodeVerifier1786931000000 } from './1786931000000-WidenZaloOauthStateCodeVerifier';

describe('WidenZaloOauthStateCodeVerifier1786931000000', () => {
  it('widens code_verifier column to varchar(512)', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    } as unknown as QueryRunner;

    await new WidenZaloOauthStateCodeVerifier1786931000000().up(queryRunner);

    expect(queries[0]).toContain('ALTER TABLE "zalo_oauth_states"');
    expect(queries[0]).toContain(
      'ALTER COLUMN "code_verifier" TYPE varchar(512)',
    );
  });
});
