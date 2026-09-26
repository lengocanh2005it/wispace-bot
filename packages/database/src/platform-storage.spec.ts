import { PLATFORMS, PLATFORM_STORAGE } from '@wispace/contracts';
import type { Platform } from '@wispace/contracts';

/**
 * Known-good schema names, declared here rather than read from the registry so
 * a typo in a table or column name is a red test here instead of a runtime SQL
 * error against a table that does not exist. Exhaustiveness of the registry is
 * already a compile error via `satisfies Record<Platform, PlatformStorage>`;
 * what a runtime test adds is the schema-parity check.
 */
const SCHEMA: Record<
  Platform,
  {
    mappingTable: string;
    verifyTable: string;
    verifyIdColumn: string;
    statusColumn: 'status' | null;
  }
> = {
  messenger: {
    mappingTable: 'user_platform_mappings',
    verifyTable: 'messenger_link_verify_records',
    verifyIdColumn: 'psid',
    statusColumn: 'status',
  },
  discord: {
    mappingTable: 'discord_account_links',
    verifyTable: 'discord_link_verify_records',
    verifyIdColumn: 'discord_user_id',
    statusColumn: null,
  },
  zalo: {
    mappingTable: 'zalo_account_links',
    verifyTable: 'zalo_link_verify_records',
    verifyIdColumn: 'zalo_user_id',
    statusColumn: null,
  },
};

describe('platform storage descriptor (#1079)', () => {
  it('covers exactly the platforms in the shared contract', () => {
    expect(Object.keys(PLATFORM_STORAGE).sort()).toEqual([...PLATFORMS].sort());
  });

  it.each(PLATFORMS)('describes the real schema for %s', (platform) => {
    expect(PLATFORM_STORAGE[platform]).toEqual(SCHEMA[platform]);
  });
});
