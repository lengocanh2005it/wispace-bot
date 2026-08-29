import type { QueryRunner } from 'typeorm';
import { AddNotificationConsentColumns1786935000000 } from './1786935000000-AddNotificationConsentColumns';

describe('AddNotificationConsentColumns1786935000000', () => {
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

  it('up adds consent columns, prompt/notice markers, and grandfather-backfills reports', async () => {
    const { runner, queries } = makeRunner();

    await new AddNotificationConsentColumns1786935000000().up(runner);

    expect(queries[0]).toContain(
      `ADD COLUMN IF NOT EXISTS "report_enabled" boolean`,
    );
    expect(queries[0]).toContain(
      `ADD COLUMN IF NOT EXISTS "reminder_enabled" boolean`,
    );
    const joined = queries.join('\n');
    expect(joined).toContain(`discord_account_links`);
    expect(joined).toContain(`optin_prompt_sent_at`);
    expect(joined).toContain(`optout_notice_sent_at`);
    // Grandfather: active Discord/Zalo links + subscribed Messenger mappings.
    expect(joined).toContain(`FROM "discord_account_links" dal`);
    expect(joined).toContain(`COALESCE(dal.link_state, 'active') = 'active'`);
    expect(joined).toContain(`FROM "zalo_account_links" zal`);
    expect(joined).toContain(
      `upm.cadence IS NOT NULL AND upm.topic IS NOT NULL`,
    );
    // Idempotent backfill — one row per user, no duplicates.
    expect(joined.match(/ON CONFLICT \("user_id"\) DO UPDATE/g)).toHaveLength(
      3,
    );
  });

  it('down drops all added columns (grandfather is reversible)', async () => {
    const { runner, queries } = makeRunner();

    await new AddNotificationConsentColumns1786935000000().down(runner);

    const joined = queries.join('\n');
    expect(joined).toContain(`DROP COLUMN IF EXISTS "reminder_enabled"`);
    expect(joined).toContain(`DROP COLUMN IF EXISTS "report_enabled"`);
    expect(joined).toContain(`DROP COLUMN IF EXISTS "optin_prompt_sent_at"`);
    expect(joined).toContain(`DROP COLUMN IF EXISTS "optout_notice_sent_at"`);
  });
});
