import type { QueryRunner } from 'typeorm';
import { CreateChatToolDailyUsageTable1786938000000 } from './1786938000000-CreateChatToolDailyUsageTable';

describe('CreateChatToolDailyUsageTable1786938000000', () => {
  function makeRunner(): { runner: QueryRunner; queries: string[] } {
    const queries: string[] = [];
    const runner = {
      query: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    } as unknown as QueryRunner;
    return { runner, queries };
  }

  it('up creates the table and the unique index', async () => {
    const { runner, queries } = makeRunner();
    await new CreateChatToolDailyUsageTable1786938000000().up(runner);
    const joined = queries.join('\n');
    expect(joined).toContain(
      'CREATE TABLE IF NOT EXISTS "chat_tool_daily_usage"',
    );
    expect(joined).toContain('"tool_name" varchar(64) NOT NULL');
    expect(joined).toContain('"count" int NOT NULL DEFAULT 0');
    expect(joined).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_tool_daily_usage"',
    );
    expect(joined).toContain(
      '("platform", "user_id", "usage_date", "tool_name")',
    );
  });

  it('down drops the table', async () => {
    const { runner, queries } = makeRunner();
    await new CreateChatToolDailyUsageTable1786938000000().down(runner);
    expect(queries.join('\n')).toContain(
      'DROP TABLE IF EXISTS "chat_tool_daily_usage"',
    );
  });
});
