import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { ConfigService } = require('@nestjs/config');
const { DataSource } = require('typeorm');
const {
  ChatDailyUsageEntity,
  ChatIdempotencyEntity,
  LlmUsageEventEntity,
} = require('@wispace/chat-metering');
const { StudyReminderJobEntity } = require('@wispace/study-reminder-shared');
const {
  DiscordAccountLinkEntity,
  LearnerProfileEntity,
  PrivacyDataService,
  ReportSendJobEntity,
  ScheduledReportClaimEntity,
  UserNotificationPreferenceEntity,
  UserPlatformMappingEntity,
  WebActivityEntity,
  ZaloAccountLinkEntity,
} = require('@wispace/database');

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
const messengerLog = require(
  resolve(
    rootDir,
    'apps/messenger-bot/dist/infrastructure/database/entities/message-log.entity.js',
  ),
).MessageLogEntity;
const discordDatabase = require(
  resolve(
    rootDir,
    'apps/discord-bot/dist/infrastructure/database/database.module.js',
  ),
);
const discordLog = require(
  resolve(
    rootDir,
    'apps/discord-bot/dist/infrastructure/database/entities/discord-message-log.entity.js',
  ),
).DiscordMessageLogEntity;
const zaloDatabase = require(
  resolve(
    rootDir,
    'apps/zalo-bot/dist/infrastructure/database/database.module.js',
  ),
);
const zaloLog = require(
  resolve(
    rootDir,
    'apps/zalo-bot/dist/infrastructure/database/entities/zalo-message-log.entity.js',
  ),
).ZaloMessageLogEntity;

const mappings = {
  messenger: UserPlatformMappingEntity,
  discord: DiscordAccountLinkEntity,
  zalo: ZaloAccountLinkEntity,
};
const scoped = {
  learnerProfile: LearnerProfileEntity,
  studyReminderJob: StudyReminderJobEntity,
  scheduledReportClaim: ScheduledReportClaimEntity,
  reportSendJob: ReportSendJobEntity,
  chatDailyUsage: ChatDailyUsageEntity,
  llmUsageEvent: LlmUsageEventEntity,
  chatIdempotency: ChatIdempotencyEntity,
  webActivity: WebActivityEntity,
  notificationPreference: UserNotificationPreferenceEntity,
};

function registry(platform, messageLog) {
  return { platform, mappings, scoped, messageLog };
}

function options(builder, { dropSchema, synchronize }) {
  return {
    ...builder(config),
    dropSchema,
    synchronize,
    migrations: [],
    logging: false,
  };
}

async function ensureVerifyIntentTables(dataSource) {
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

async function runPlatform({
  platform,
  builder,
  messageLog,
  dropSchema,
  synchronize,
}) {
  const dataSource = new DataSource(
    options(builder, { dropSchema, synchronize }),
  );
  try {
    await dataSource.initialize();
    await ensureVerifyIntentTables(dataSource);
    const service = new PrivacyDataService(
      dataSource,
      registry(platform, messageLog),
    );
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
    // Mappings must share the exact externalUserId passed to delete() so the
    // current-platform mapping is found and the cross-platform delete runs.
    for (const mappingPlatform of Object.keys(mappings)) {
      await insertMapping(
        dataSource,
        mappingPlatform,
        deleteId,
        deleteUserId,
      );
    }
    await insertScopedRows(dataSource, platform, deleteId, deleteUserId);
    await insertMessageLog(dataSource, platform, deleteId, deleteUserId);
    await service.delete(platform, deleteId);
    await assertDeleted(dataSource, platform, deleteId, deleteUserId);

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
  messageLog: messengerLog,
  dropSchema: true,
  synchronize: true,
});
await runPlatform({
  platform: 'discord',
  builder: discordDatabase.buildTypeOrmOptions,
  messageLog: discordLog,
  dropSchema: false,
  synchronize: false,
});
await runPlatform({
  platform: 'zalo',
  builder: zaloDatabase.buildTypeOrmOptions,
  messageLog: zaloLog,
  dropSchema: false,
  synchronize: false,
});
