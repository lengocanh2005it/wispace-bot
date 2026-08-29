import type { QueryRunner } from 'typeorm';
import { AddPlatformLinkOwnershipState1786933000000 } from './1786933000000-AddPlatformLinkOwnershipState';

describe('AddPlatformLinkOwnershipState1786933000000', () => {
  it('normalizes cancelled jobs before restoring legacy constraints on rollback', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    } as unknown as QueryRunner;

    await new AddPlatformLinkOwnershipState1786933000000().down(queryRunner);

    expect(queries).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `UPDATE "report_send_jobs" SET "status" = 'failed'`,
        ),
        expect.stringContaining(
          `UPDATE "scheduled_report_claims" SET "status" = 'released'`,
        ),
      ]),
    );
  });
});
