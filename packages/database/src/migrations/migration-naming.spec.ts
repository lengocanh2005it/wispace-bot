import type { QueryRunner } from 'typeorm';
import { LEGACY_MIGRATION_NAME_ALIASES } from '../migration-data-source';
import { AddBurstLimitReservationIndex1786920000013 } from './1786920000013-AddBurstLimitReservationIndex';
import { AddZaloOaTokenVersion1786920000014 } from './1786920000014-AddZaloOaTokenVersion';
import { AddWebhookInboundStaleIndex1786920000006 } from './1786920000006-AddWebhookInboundStaleIndex';
import { AddZaloOauthStateCleanupIndex1786920000005 } from './1786920000005-AddZaloOauthStateCleanupIndex';

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
