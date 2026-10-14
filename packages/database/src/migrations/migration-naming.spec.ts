import type { QueryRunner } from 'typeorm';
import { LEGACY_MIGRATION_NAME_ALIASES } from '../migration-data-source';
import { AddBurstLimitReservationIndex1786920000013 } from './1786920000013-AddBurstLimitReservationIndex';
import { AddZaloOaTokenVersion1786920000014 } from './1786920000014-AddZaloOaTokenVersion';
import { AddWebhookInboundStaleIndex1786920000006 } from './1786920000006-AddWebhookInboundStaleIndex';
import { AddRescheduleAttemptPlatformDueIndex1789094100000 } from './1789094100000-AddRescheduleAttemptPlatformDueIndex';
import { AddZaloOauthStateCleanupIndex1786920000005 } from './1786920000005-AddZaloOauthStateCleanupIndex';

describe('AddRescheduleAttemptPlatformDueIndex (#1507)', () => {
  const run = async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    } as unknown as QueryRunner;
    const migration = new AddRescheduleAttemptPlatformDueIndex1789094100000();
    await migration.up(queryRunner);
    return queries;
  };

  it('adds the platform-leading index before dropping the one it replaces', async () => {
    const queries = await run();

    // Creating first keeps the table indexed at every point of the migration.
    expect(queries[0]).toContain('idx_reschedule_attempt_platform_due');
    expect(queries[0]).toContain('"platform", "status"');
    expect(queries[1]).toContain(
      'DROP INDEX IF EXISTS "idx_reschedule_attempt_notification_due"',
    );
  });

  it('restores the previous index on revert', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    } as unknown as QueryRunner;
    const migration = new AddRescheduleAttemptPlatformDueIndex1789094100000();

    await migration.down(queryRunner);

    expect(queries[0]).toContain('idx_reschedule_attempt_notification_due');
    expect(queries[1]).toContain(
      'DROP INDEX IF EXISTS "idx_reschedule_attempt_platform_due"',
    );
  });
});

describe('migration timestamp compatibility', () => {
  it('keeps corrected runtime names unique and maps every historical name', () => {
    const migrations = [
      new AddBurstLimitReservationIndex1786920000013(),
      new AddZaloOauthStateCleanupIndex1786920000005(),
      new AddZaloOaTokenVersion1786920000014(),
      new AddWebhookInboundStaleIndex1786920000006(),
    ];
    const timestamps = migrations.map(({ name }) => name.slice(-13));

    expect(new Set(timestamps).size).toBe(timestamps.length);
    expect(Object.values(LEGACY_MIGRATION_NAME_ALIASES)).toEqual(
      expect.arrayContaining(migrations.map(({ name }) => name)),
    );
  });

  it('makes the renamed column migration safe to replay', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: async (sql: string) => {
        queries.push(sql);
        return [];
      },
    } as unknown as QueryRunner;

    await new AddZaloOaTokenVersion1786920000014().up(queryRunner);

    expect(queries).toEqual([
      'ALTER TABLE "zalo_oa_tokens" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 0',
    ]);
  });
});
