import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { ConfigService } = require('@nestjs/config');
const { DataSource } = require('typeorm');
// Entity targets are not listed here on purpose — they come from each app's
// exported `buildPrivacyEntityRegistry` below (#461).
const { PrivacyDataService } = require('@wispace/database');

const requiredEnv = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
for (const key of requiredEnv) {
  if (!process.env[key]?.trim()) {
    throw new Error(`database privacy smoke requires ${key}`);
  }
}
if (
  process.env.NODE_ENV !== 'test' ||
  !['127.0.0.1', 'localhost', '::1'].includes(
    process.env.DB_HOST.trim().toLowerCase(),
  )
) {
  throw new Error(
    'database privacy smoke requires NODE_ENV=test and a loopback DB_HOST',
  );
}

const config = new ConfigService({ ...process.env });
const messengerTypeOrm = require(
  resolve(
    rootDir,
    'apps/messenger-bot/dist/infrastructure/database/typeorm.options.js',
  ),
);
const messengerDatabase = require(
  resolve(
    rootDir,
    'apps/messenger-bot/dist/infrastructure/database/database.module.js',
  ),
);
const discordDatabase = require(
  resolve(
    rootDir,
    'apps/discord-bot/dist/infrastructure/database/database.module.js',
  ),
);
const zaloDatabase = require(
  resolve(
    rootDir,
    'apps/zalo-bot/dist/infrastructure/database/database.module.js',
  ),
);

// The registries the apps actually wire (#461). Built by each app's own
// `buildPrivacyEntityRegistry`, not restated here — a local copy would pass
// this smoke while an app's real registration was wrong, which is the blind
// spot the issue was about.
const appRegistries = {
  messenger: messengerDatabase.buildPrivacyEntityRegistry(),
  discord: discordDatabase.buildPrivacyEntityRegistry(),
  zalo: zaloDatabase.buildPrivacyEntityRegistry(),
};

// Only `platform` and `messageLog` may differ between apps; every shared
// target must be the identical class, or one app is erasing different rows.
for (const [platform, appRegistry] of Object.entries(appRegistries)) {
  assert.equal(
    appRegistry.platform,
    platform,
    `${platform} registry declares platform=${appRegistry.platform}`,
  );
  for (const key of Object.keys(appRegistries.messenger.mappings)) {
    assert.equal(
      appRegistry.mappings[key],
      appRegistries.messenger.mappings[key],
      `${platform} registry disagrees on mappings.${key}`,
    );
  }
  for (const key of Object.keys(appRegistries.messenger.scoped)) {
    assert.equal(
      appRegistry.scoped[key],
      appRegistries.messenger.scoped[key],
      `${platform} registry disagrees on scoped.${key}`,
    );
  }
}

const mappings = appRegistries.messenger.mappings;
const scoped = appRegistries.messenger.scoped;
// Per-app, so these come from each registry rather than a separate require.
const messengerLog = appRegistries.messenger.messageLog;
const discordLog = appRegistries.discord.messageLog;
const zaloLog = appRegistries.zalo.messageLog;

function options(builder, { dropSchema, synchronize }) {
  return {
    ...builder(config),
    dropSchema,
    synchronize,
    migrations: [],
    logging: false,
  };
}

/** Column each platform's verify-record table is keyed on. */
const VERIFY_INTENT_COLUMNS = {
  messenger: ['messenger_link_verify_records', 'psid'],
  discord: ['discord_link_verify_records', 'discord_user_id'],
  zalo: ['zalo_link_verify_records', 'zalo_user_id'],
};

async function ensureVerifyIntentTables(dataSource) {
  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS "messenger_link_verify_records" (
      "psid" varchar(64) PRIMARY KEY,
      "user_id" integer NOT NULL,
      "verified_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS "discord_link_verify_records" (
      "discord_user_id" varchar(64) PRIMARY KEY,
      "user_id" integer NOT NULL,
      "verified_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS "zalo_link_verify_records" (
      "zalo_user_id" varchar(64) PRIMARY KEY,
      "user_id" integer NOT NULL,
      "verified_at" timestamptz NOT NULL
    )
  `);
}

async function insertMapping(dataSource, platform, externalUserId, userId) {
  if (platform === 'messenger') {
    await dataSource.getRepository(mappings.messenger).insert({
      platform,
      externalUserId,
      userId,
      notificationMessagesToken: `smoke-token-${externalUserId}`,
      cadence: null,
      topic: null,
      status: 'ACTIVE',
      linkState: 'active',
      mappingGeneration: '1',
    });
    return;
  }
  await dataSource.getRepository(mappings[platform]).insert({
    platform,
    externalUserId,
    userId,
    linkState: 'active',
    mappingGeneration: '1',
  });
}

async function insertScopedRows(dataSource, platform, externalUserId, userId) {
  const date = '2026-09-01';
  const now = new Date();
  await dataSource.getRepository(scoped.learnerProfile).insert({
    platform,
    externalUserId,
    userId,
    targetScore: 7,
    examDate: '2026-12-31',
    targetScoreFetchedAt: now,
    examDateFetchedAt: now,
    updatedAt: now,
  });
  await dataSource.getRepository(scoped.studyReminderJob).insert({
    platform,
    externalUserId,
    userId,
    sessionKey: `smoke-session-${externalUserId}`,
    scheduledAt: now,
    remindAt: now,
  });
  await dataSource.getRepository(scoped.scheduledReportClaim).insert({
    platform,
    externalUserId,
    userId,
    reportDate: date,
  });
  await dataSource.getRepository(scoped.reportSendJob).insert({
    platform,
    externalUserId,
    userId,
    examDate: date,
    firstAttemptDate: date,
  });
  await dataSource.getRepository(scoped.chatDailyUsage).insert({
    platform,
    externalUserId,
    userId,
    usageDate: date,
  });
  await dataSource.getRepository(scoped.llmUsageEvent).insert({
    platform,
    externalUserId,
    userId,
    usageDate: date,
    feature: 'privacy-smoke',
    model: 'smoke',
  });
  await dataSource.getRepository(scoped.chatIdempotency).insert({
    idempotencyKey: `smoke-idempotency-${externalUserId}`,
    platform,
    externalUserId,
    userId,
    usageDate: date,
  });
  await dataSource.getRepository(scoped.webActivity).insert({
    userId,
    lastActiveAt: now,
  });
  await dataSource.getRepository(scoped.notificationPreference).insert({
    userId,
    preferredPlatform: platform,
  });
}

async function insertMessageLog(dataSource, platform, externalUserId, userId) {
  if (platform === 'messenger') {
    await dataSource.getRepository(messengerLog).insert({
      platform,
      externalUserId,
      userId,
      status: 'SENT',
      messageType: 'privacy-smoke',
    });
    return;
  }
  await dataSource
    .getRepository(platform === 'discord' ? discordLog : zaloLog)
    .insert({
      platform,
      externalUserId,
      status: 'SENT',
      messageType: 'privacy-smoke',
    });
}

async function assertDeleted(dataSource, platform, externalUserId, userId) {
  for (const mapping of Object.values(mappings)) {
    assert.equal(
      await dataSource.getRepository(mapping).count({ where: { userId } }),
      0,
      `${platform}: cross-platform mapping survived delete`,
    );
  }
  for (const [name, entity] of Object.entries(scoped)) {
    assert.equal(
      await dataSource.getRepository(entity).count({ where: { userId } }),
      0,
      `${platform}: ${name} survived delete`,
    );
  }
  const logTarget =
    platform === 'messenger'
      ? messengerLog
      : platform === 'discord'
        ? discordLog
        : zaloLog;
  assert.equal(
    await dataSource
      .getRepository(logTarget)
      .count({ where: { platform, externalUserId } }),
    1,
    `${platform}: message log was unexpectedly deleted`,
  );
}

async function seedVerifyIntent(dataSource, crossIds, userId) {
  for (const [mappingPlatform, externalId] of Object.entries(crossIds)) {
    const [table, column] = VERIFY_INTENT_COLUMNS[mappingPlatform];
    await dataSource.query(
      `INSERT INTO "${table}" ("${column}", "user_id", "verified_at")
       VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
      [externalId, userId],
    );
  }
}

/**
 * Outcomes that only the cross-platform fan-out can produce (#461).
 *
 * - An audit row per OTHER platform, hashed on that platform's own external
 *   id — proves delete() reached the learner's other identities by userId,
 *   not just the id it was called with.
 * - That platform's verify-record is gone. Verify-records are not part of the
 *   scoped userId sweep, so their deletion is attributable to the fan-out.
 *
 * Deliberately NOT asserted: reminder jobs moving to `cancelled`. The fan-out
 * does set that, but `delete()` then removes those rows by userId anyway, so
 * the final state is identical either way and the assertion would prove
 * nothing. It is observable on the `unlink()` path, not here.
 */
async function assertCrossPlatformFanOut(dataSource, platform, crossIds) {
  for (const [mappingPlatform, externalId] of Object.entries(crossIds)) {
    if (mappingPlatform === platform) continue;
    const hash = createHash('sha256').update(externalId).digest('hex');
    const audit = await dataSource.query(
      `SELECT 1 FROM platform_link_audit_events
       WHERE platform = $1 AND external_user_hash = $2
         AND event_type = 'locally_unlinked'`,
      [mappingPlatform, hash],
    );
    assert.equal(
      audit.length > 0,
      true,
      `${platform}: no cross-platform unlink audit for ${mappingPlatform} (${externalId})`,
    );
  }

  // Every identity's verify-record must be gone: the current platform's via
  // its own delete path, the others via the fan-out.
  for (const [mappingPlatform, externalId] of Object.entries(crossIds)) {
    const [table, column] = VERIFY_INTENT_COLUMNS[mappingPlatform];
    const remaining = await dataSource.query(
      `SELECT 1 FROM "${table}" WHERE "${column}" = $1`,
      [externalId],
    );
    assert.equal(
      remaining.length,
      0,
      `${platform}: ${mappingPlatform} verify-record survived delete (${externalId})`,
    );
  }
}

async function runPlatform({ platform, builder, dropSchema, synchronize }) {
  const dataSource = new DataSource(
    options(builder, { dropSchema, synchronize }),
  );
  try {
    await dataSource.initialize();
    await ensureVerifyIntentTables(dataSource);
    const service = new PrivacyDataService(dataSource, appRegistries[platform]);
    const seed = { messenger: 1, discord: 2, zalo: 3 }[platform];

    const unlinkId = `${platform}-privacy-unlink`;
    await insertMapping(dataSource, platform, unlinkId, 7100 + seed);
    await service.unlink(platform, unlinkId);
    const unlinked = await dataSource
      .getRepository(mappings[platform])
      .findOne({ where: { platform, externalUserId: unlinkId } });
    assert.equal(unlinked?.linkState, 'locally-unlinked');
    assert.equal(unlinked?.mappingGeneration, '2');

    const deleteId = `${platform}-privacy-delete`;
    const deleteUserId = 7200 + seed;
    // The current platform's mapping must carry the exact externalUserId
    // passed to delete(). The OTHER platforms are reached by userId alone, so
    // they get DISTINCT ids here — seeding them with the same id would make
    // the cross-platform fan-out indistinguishable from the current-platform
    // path, which is the branch #461 is about.
    const crossIds = {};
    for (const mappingPlatform of Object.keys(mappings)) {
      crossIds[mappingPlatform] =
        mappingPlatform === platform
          ? deleteId
          : `${mappingPlatform}-cross-of-${platform}`;
      await insertMapping(
        dataSource,
        mappingPlatform,
        crossIds[mappingPlatform],
        deleteUserId,
      );
    }
    await insertScopedRows(dataSource, platform, deleteId, deleteUserId);
    await insertMessageLog(dataSource, platform, deleteId, deleteUserId);
    await seedVerifyIntent(dataSource, crossIds, deleteUserId);
    await service.delete(platform, deleteId);
    await assertDeleted(dataSource, platform, deleteId, deleteUserId);
    await assertCrossPlatformFanOut(dataSource, platform, crossIds);

    const exportId = `${platform}-privacy-export`;
    const exportUserId = 7300 + seed;
    await insertMapping(dataSource, platform, exportId, exportUserId);
    await insertScopedRows(dataSource, platform, exportId, exportUserId);
    await insertMessageLog(dataSource, platform, exportId, exportUserId);
    const exported = await service.export(platform, exportId);
    assert.equal(exported.studyReminderJobs, 1);
    assert.equal(exported.scheduledReportClaims, 1);
    assert.equal(exported.reportSendJobs, 1);
    assert.equal(exported.messageLogs, 1);
    assert.equal(exported.learnerProfile?.targetScore, 7);
    console.log(`${platform}: privacy unlink/delete/export passed`);
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

await runPlatform({
  platform: 'messenger',
  builder: messengerTypeOrm.getTypeOrmOptions,
  dropSchema: true,
  synchronize: true,
});
await runPlatform({
  platform: 'discord',
  builder: discordDatabase.buildTypeOrmOptions,
  dropSchema: false,
  synchronize: false,
});
await runPlatform({
  platform: 'zalo',
  builder: zaloDatabase.buildTypeOrmOptions,
  dropSchema: false,
  synchronize: false,
});
