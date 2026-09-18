import type { QueryRunner } from 'typeorm';
import {
  currentChatUsageDate,
  OwnerAwareChatDailyUsageKeys1789093800000,
} from './1789093800000-OwnerAwareChatDailyUsageKeys';

describe('OwnerAwareChatDailyUsageKeys1789093800000', () => {
  it('uses the configured chat timezone for the one-day backfill', () => {
    const now = new Date('2026-09-18T23:30:00.000Z');

    expect(currentChatUsageDate(now, 'UTC')).toBe('2026-09-18');
    expect(currentChatUsageDate(now, 'Asia/Ho_Chi_Minh')).toBe('2026-09-19');
  });

  function makeRunner(): {
    runner: QueryRunner;
    queries: string[];
    params: unknown[][];
  } {
    const queries: string[] = [];
    const params: unknown[][] = [];
    const runner = {
      query: async (sql: string, queryParams?: unknown[]) => {
        queries.push(sql);
        params.push(queryParams ?? []);
        return [];
      },
    } as unknown as QueryRunner;
    return { runner, queries, params };
  }

  it('replaces the legacy conflict target with owner-aware uniqueness', async () => {
    const { runner, queries } = makeRunner();
    await new OwnerAwareChatDailyUsageKeys1789093800000().up(runner);
    const joined = queries.join('\n');

    expect(joined).toContain(
      'DROP INDEX IF EXISTS "uq_chat_daily_usage_platform_external_date"',
    );
    expect(joined).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_daily_usage_linked"',
    );
    expect(joined).toContain(
      '("platform", "external_user_id", "usage_date", "user_id")',
    );
    expect(joined).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_daily_usage_anonymous"',
    );
    expect(joined).toContain('WHERE "user_id" IS NULL');
  });

  it('creates owner-aware keys before dropping the legacy key', async () => {
    const { runner, queries } = makeRunner();
    await new OwnerAwareChatDailyUsageKeys1789093800000().up(runner);

    const dropAt = queries.findIndex((sql) =>
      sql.includes(
        'DROP INDEX IF EXISTS "uq_chat_daily_usage_platform_external_date"',
      ),
    );
    const linkedAt = queries.findIndex((sql) =>
      sql.includes(
        'CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_daily_usage_linked"',
      ),
    );

    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(linkedAt).toBeLessThan(dropAt);
  });

  it('copies only current-day anonymous rows with an active mapping', async () => {
    const { runner, queries, params } = makeRunner();
    await new OwnerAwareChatDailyUsageKeys1789093800000().up(runner);
    const backfill = queries.find((sql) =>
      sql.includes('INSERT INTO "chat_daily_usage"'),
    );

    expect(backfill).toBeDefined();
    expect(backfill).toContain('WHERE usage."user_id" IS NULL');
    expect(backfill).toContain('AND usage."usage_date" = $1::date');
    expect(backfill).toContain('user_id IS NOT NULL');
    expect(backfill).toContain('external_user_id IS NOT NULL');
    expect(backfill).toContain('FROM user_platform_mappings');
    expect(backfill).toContain('FROM discord_account_links');
    expect(backfill).toContain('FROM zalo_account_links');
    expect(backfill).toContain('DO NOTHING');
    expect(params[params.length - 1]).toEqual([currentChatUsageDate()]);
  });

  it('runs the backfill after the owner-aware keys exist', async () => {
    const { runner, queries } = makeRunner();
    await new OwnerAwareChatDailyUsageKeys1789093800000().up(runner);

    const anonymousAt = queries.findIndex((sql) =>
      sql.includes('uq_chat_daily_usage_anonymous'),
    );
    const backfillAt = queries.findIndex((sql) =>
      sql.includes('INSERT INTO "chat_daily_usage"'),
    );

    expect(anonymousAt).toBeGreaterThanOrEqual(0);
    expect(backfillAt).toBeGreaterThan(anonymousAt);
  });

  it('down restores the legacy key without merging buckets', async () => {
    const { runner, queries } = makeRunner();
    await new OwnerAwareChatDailyUsageKeys1789093800000().down(runner);
    const joined = queries.join('\n');

    expect(joined).toContain(
      'DROP INDEX IF EXISTS "uq_chat_daily_usage_anonymous"',
    );
    expect(joined).toContain(
      'DROP INDEX IF EXISTS "uq_chat_daily_usage_linked"',
    );
    expect(joined).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_daily_usage_platform_external_date"',
    );
    expect(joined).not.toContain('UPDATE "chat_daily_usage"');
    expect(joined).not.toContain('DELETE FROM "chat_daily_usage"');
  });
});
