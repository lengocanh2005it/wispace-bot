import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { ConfigService } = require('@nestjs/config');
const { DataSource } = require('typeorm');
const IORedis = require('ioredis');
const {
  PrivacyCleanupJobStore,
  PrivacyCleanupReconciler,
  PrivacyDataService,
} = require('@wispace/database');
const {
  RedisClarificationStateStore,
  RedisChatQueueStore,
} = require('@wispace/chat-agent');
const { RedisChatHistoryStore } = require('@wispace/chat-history');
const { RedisUserDisplayNameCache } = require('@wispace/bot-common/redis');

const config = new ConfigService({ ...process.env });
const host = requireLoopback('DB_HOST');
const redisHost = requireLoopback('REDIS_HOST');
const redisPort = Number(process.env.REDIS_PORT ?? 6379);
if (process.env.NODE_ENV !== 'test') {
  throw new Error('privacy erasure drill requires NODE_ENV=test');
}
if (!Number.isInteger(redisPort) || redisPort < 1 || redisPort > 65_535) {
  throw new Error('privacy erasure drill requires a valid REDIS_PORT');
}

const platformConfig = {
  messenger: {
    builder: require(
      resolve(
        rootDir,
        'apps/messenger-bot/dist/infrastructure/database/typeorm.options.js',
      ),
    ).getTypeOrmOptions,
    registry: require(
      resolve(
        rootDir,
        'apps/messenger-bot/dist/infrastructure/database/database.module.js',
      ),
    ).buildPrivacyEntityRegistry(),
    stores: [
      'chat_history',
      'chat_queue',
      'clarification_state',
      'display_name_cache',
    ],
    historyPrefix: 'chat:history:',
    queueOptions: { platform: 'messenger', legacyKeys: true },
  },
  discord: {
    builder: require(
      resolve(
        rootDir,
        'apps/discord-bot/dist/infrastructure/database/database.module.js',
      ),
    ).buildTypeOrmOptions,
    registry: require(
      resolve(
        rootDir,
        'apps/discord-bot/dist/infrastructure/database/database.module.js',
      ),
    ).buildPrivacyEntityRegistry(),
    stores: ['chat_history', 'chat_queue', 'clarification_state'],
    historyPrefix: 'chat-history:discord:',
    queueOptions: { platform: 'discord' },
  },
  zalo: {
    builder: require(
      resolve(
        rootDir,
        'apps/zalo-bot/dist/infrastructure/database/database.module.js',
      ),
    ).buildTypeOrmOptions,
    registry: require(
      resolve(
        rootDir,
        'apps/zalo-bot/dist/infrastructure/database/database.module.js',
      ),
    ).buildPrivacyEntityRegistry(),
    stores: ['chat_history', 'chat_queue', 'clarification_state'],
    historyPrefix: 'chat-history:zalo:',
    queueOptions: { platform: 'zalo' },
  },
};

const mappingTables = {
  messenger: 'user_platform_mappings',
  discord: 'discord_account_links',
  zalo: 'zalo_account_links',
};

if (process.argv[2] === '--worker') {
  await runWorker(process.argv[3]);
} else {
  await runDrill();
}

function requireLoopback(name) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value || !['127.0.0.1', 'localhost', '::1'].includes(value)) {
    throw new Error(`privacy erasure drill requires loopback ${name}`);
  }
  return value;
}

function buildDataSource(platform) {
  const options = platformConfig[platform];
  if (!options) throw new Error(`unknown privacy drill platform: ${platform}`);
  return new DataSource({
    ...options.builder(config),
    host,
    synchronize: false,
    migrations: [],
    logging: false,
  });
}

function redisClient(port, { lazyConnect = false } = {}) {
  const client = new IORedis({
    host: redisHost,
    port,
    lazyConnect,
    connectTimeout: 500,
    commandTimeout: 500,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: null,
  });
  // The outage client intentionally emits connection errors.
  client.on('error', () => undefined);
  return client;
}

function redisPortAdapter(client) {
  return {
    isEnabled: () => true,
    isConfiguredEnabled: () => true,
    ping: () => client.ping(),
    getNativeClient: () => client,
  };
}

function buildStores(platform, client) {
  const options = platformConfig[platform];
  const clientPort = redisPortAdapter(client);
  return {
    client,
    history: new RedisChatHistoryStore(client, {
      ttlSec: 3600,
      maxMessages: 40,
      keyPrefix: options.historyPrefix,
    }),
    queue: new RedisChatQueueStore(clientPort, config, options.queueOptions),
    clarification: new RedisClarificationStateStore(
      clientPort,
      `chat:clarification:${platform}`,
    ),
    displayName:
      platform === 'messenger'
        ? new RedisUserDisplayNameCache(clientPort, config, { platform })
        : undefined,
  };
}

function cleanupCallbacks(platform, stores) {
  return {
    platform,
    applicableStores: platformConfig[platform].stores,
    clearHistory: (id) => stores.history.clear(id),
    clearQueuedWork: async (id) => {
      await stores.queue.clearChatBuffer(id);
    },
    clearClarification: async (id) => {
      await stores.clarification.clear(`${platform}:${id}`);
    },
    ...(stores.displayName
      ? { clearUserCache: (id) => stores.displayName.delStrict(id) }
      : {}),
  };
}

async function runDrill() {
  const outagePort = Number(process.env.PRIVACY_DRILL_OUTAGE_PORT ?? 1);
  assert.notEqual(outagePort, redisPort, 'outage Redis port must differ');
  await assertMigrationApplied();

  for (const platform of Object.keys(platformConfig)) {
    await runDeleteRecovery(platform, outagePort);
    await runRelinkFence(platform, outagePort);
    console.log(`${platform}: durable delete recovery + relink fence passed`);
  }
  await runRetentionCheck();
  console.log('privacy: PostgreSQL/Redis fresh-process drill passed');
}

async function runRetentionCheck() {
  const dataSource = buildDataSource('messenger');
  const probe = `retention-${process.pid}-${Date.now()}`;
  try {
    await dataSource.initialize();
    for (const [status, suffix] of [
      ['completed', 'completed'],
      ['stale', 'stale'],
      ['pending', 'pending'],
    ]) {
      await dataSource.query(
        `INSERT INTO privacy_cleanup_jobs
          (cleanup_id, idempotency_key, operation, platform, external_user_id,
           mapping_generation, store, status, next_retry_at,
           updated_at, completed_at, stale_at)
         VALUES ($1, $2, 'delete', 'messenger', $3, '1', 'chat_history',
                 $4::varchar, now(), now() - interval '8 days',
                 CASE WHEN $4::varchar = 'completed' THEN now() - interval '8 days' END,
                 CASE WHEN $4::varchar = 'stale' THEN now() - interval '8 days' END)`,
        [`${probe}-${suffix}`, `${probe}:${suffix}`, probe, status],
      );
    }
    const removed = await new PrivacyCleanupJobStore(
      dataSource,
    ).pruneRetention();
    assert.equal(removed, 2);
    const rows = await dataSource.query(
      `SELECT status FROM privacy_cleanup_jobs WHERE cleanup_id LIKE $1 ORDER BY status`,
      [`${probe}-%`],
    );
    assert.deepEqual(rows, [{ status: 'pending' }]);
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.query(
        `DELETE FROM privacy_cleanup_jobs WHERE cleanup_id LIKE $1`,
        [`${probe}-%`],
      );
      await dataSource.destroy();
    }
  }
}

async function assertMigrationApplied() {
  const dataSource = buildDataSource('messenger');
  try {
    await dataSource.initialize();
    const rows = await dataSource.query(
      `SELECT name FROM migrations WHERE name = $1`,
      ['CreatePrivacyCleanupJobs1789093700000'],
    );
    assert.equal(rows.length, 1, 'privacy cleanup migration was not applied');
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

async function runDeleteRecovery(platform, outagePort) {
  const externalUserId = `pd-${platform[0]}-${process.pid}-${Date.now()}`;
  const userId = 90_000 + Object.keys(platformConfig).indexOf(platform);
  const healthy = redisClient(redisPort, { lazyConnect: true });
  const outage = redisClient(outagePort, { lazyConnect: true });
  const dataSource = buildDataSource(platform);
  try {
    await healthy.connect();
    await healthy.ping();
    await assertRedisUnavailable(outage);
    const stores = buildStores(platform, healthy);
    await seedRedisState(platform, stores, externalUserId, userId);
    await dataSource.initialize();
    await seedMapping(dataSource, platform, externalUserId, userId);
    const service = new PrivacyDataService(
      dataSource,
      platformConfig[platform].registry,
    );
    const failedStores = buildStores(platform, outage);
    const result = await service.delete(
      platform,
      externalUserId,
      cleanupCallbacks(platform, failedStores),
    );
    assert.equal(result.status, 'incomplete');
    assert.equal(result.deleted, true);
    assert.deepEqual(result.outstandingStores, platformConfig[platform].stores);
    const rows = await dataSource.query(
      `SELECT store, status, attempt_count FROM privacy_cleanup_jobs WHERE cleanup_id = $1 ORDER BY store`,
      [result.cleanupId],
    );
    assert.equal(rows.length, platformConfig[platform].stores.length);
    assert(rows.every((row) => row.status === 'pending'));
    assert(rows.every((row) => Number(row.attempt_count) === 3));
    await dataSource.query(
      `UPDATE privacy_cleanup_jobs SET next_retry_at = now() WHERE cleanup_id = $1`,
      [result.cleanupId],
    );
    await dataSource.destroy();
    await outage.disconnect();

    const worker = runFreshWorker(platform);
    assert.equal(worker.completed, platformConfig[platform].stores.length);
    assert.equal(worker.failed, 0);
    assert.equal(worker.stale, 0);

    const verify = buildDataSource(platform);
    await verify.initialize();
    try {
      const completed = await verify.query(
        `SELECT status FROM privacy_cleanup_jobs WHERE cleanup_id = $1`,
        [result.cleanupId],
      );
      assert.equal(completed.length, platformConfig[platform].stores.length);
      assert(completed.every((row) => row.status === 'completed'));
      await assertRedisStateAbsent(platform, stores, externalUserId, userId);
      await cleanupRedisState(platform, stores, externalUserId, userId);
      await verify.query(
        `DELETE FROM privacy_cleanup_jobs WHERE cleanup_id = $1`,
        [result.cleanupId],
      );
    } finally {
      await verify.destroy();
    }
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
    outage.disconnect();
    healthy.disconnect();
  }
}

async function runRelinkFence(platform, outagePort) {
  const externalUserId = `pf-${platform[0]}-${process.pid}-${Date.now()}`;
  const userId = 91_000 + Object.keys(platformConfig).indexOf(platform);
  const newUserId = userId + 100;
  const healthy = redisClient(redisPort, { lazyConnect: true });
  const outage = redisClient(outagePort, { lazyConnect: true });
  const dataSource = buildDataSource(platform);
  try {
    await healthy.connect();
    await healthy.ping();
    await assertRedisUnavailable(outage);
    const stores = buildStores(platform, healthy);
    await seedRedisState(platform, stores, externalUserId, userId);
    await dataSource.initialize();
    await seedMapping(dataSource, platform, externalUserId, userId);
    const service = new PrivacyDataService(
      dataSource,
      platformConfig[platform].registry,
    );
    const failedStores = buildStores(platform, outage);
    const result = await service.unlink(
      platform,
      externalUserId,
      cleanupCallbacks(platform, failedStores),
    );
    assert.equal(result.status, 'incomplete');
    await dataSource.query(
      `UPDATE privacy_cleanup_jobs SET next_retry_at = now() WHERE cleanup_id = $1`,
      [result.cleanupId],
    );
    await relinkMapping(dataSource, platform, externalUserId, newUserId);
    await dataSource.destroy();
    await outage.disconnect();

    const worker = runFreshWorker(platform);
    assert.equal(worker.stale, platformConfig[platform].stores.length);
    assert.equal(worker.completed, 0);
    assert.equal(worker.failed, 0);

    const verify = buildDataSource(platform);
    await verify.initialize();
    try {
      const stale = await verify.query(
        `SELECT status FROM privacy_cleanup_jobs WHERE cleanup_id = $1`,
        [result.cleanupId],
      );
      assert.equal(stale.length, platformConfig[platform].stores.length);
      assert(stale.every((row) => row.status === 'stale'));
      await assertRedisStatePresent(platform, stores, externalUserId, userId);
      await cleanupRedisState(platform, stores, externalUserId, userId);
      await verify.query(
        `DELETE FROM privacy_cleanup_jobs WHERE cleanup_id = $1`,
        [result.cleanupId],
      );
      await deleteMapping(verify, platform, externalUserId);
    } finally {
      await verify.destroy();
    }
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
    outage.disconnect();
    healthy.disconnect();
  }
}

function runFreshWorker(platform) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), '--worker', platform],
    {
      cwd: rootDir,
      env: { ...process.env },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(`fresh ${platform} worker failed:\n${result.stderr}`);
  }
  const lines = result.stdout.trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1));
}

async function runWorker(platform) {
  if (!platformConfig[platform])
    throw new Error(`unknown worker platform: ${platform}`);
  const dataSource = buildDataSource(platform);
  const redis = redisClient(redisPort, { lazyConnect: true });
  try {
    await dataSource.initialize();
    await redis.connect();
    const stores = buildStores(platform, redis);
    const reconciler = new PrivacyCleanupReconciler(
      dataSource,
      platform,
      cleanupCallbacks(platform, stores),
    );
    console.log(JSON.stringify(await reconciler.runOnce()));
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
    await redis.quit().catch(() => redis.disconnect());
  }
}

async function assertRedisUnavailable(client) {
  await assert.rejects(() => client.connect());
}

async function seedMapping(dataSource, platform, externalUserId, userId) {
  await dataSource.query(
    `INSERT INTO "${mappingTables[platform]}"
      (platform, external_user_id, user_id, link_state, mapping_generation${platform === 'messenger' ? ', notification_messages_token, status' : ''})
     VALUES ($1, $2, $3, 'active', '1'${platform === 'messenger' ? ", $4, 'ACTIVE'" : ''})`,
    platform === 'messenger'
      ? [
          platform,
          externalUserId,
          userId,
          `privacy-drill-token-${process.pid}-${userId}`,
        ]
      : [platform, externalUserId, userId],
  );
}

async function relinkMapping(dataSource, platform, externalUserId, userId) {
  await dataSource.query(
    `UPDATE "${mappingTables[platform]}"
        SET user_id = $1, link_state = 'active', mapping_generation = '3', updated_at = now()${platform === 'messenger' ? ", status = 'ACTIVE'" : ''}
      WHERE platform = $2 AND external_user_id = $3`,
    [userId, platform, externalUserId],
  );
}

async function deleteMapping(dataSource, platform, externalUserId) {
  await dataSource.query(
    `DELETE FROM "${mappingTables[platform]}" WHERE platform = $1 AND external_user_id = $2`,
    [platform, externalUserId],
  );
}

async function seedRedisState(platform, stores, externalUserId, userId) {
  await stores.history.appendTurn(externalUserId, 'drill user', 'drill reply');
  await stores.queue.appendChatBuffer({
    externalUserId,
    userText: 'drill queued text',
    userId,
    debounceMs: 1,
  });
  await stores.clarification.set(`${platform}:${externalUserId}`, {
    phase: 'awaiting_choice',
    attempts: 0,
    menuResets: 0,
    version: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
  await stores.displayName?.set(userId, { displayName: 'Privacy Drill' });
}

async function assertRedisStatePresent(
  platform,
  stores,
  externalUserId,
  userId,
) {
  assert((await stores.history.getHistory(externalUserId)).length > 0);
  assert.equal(await queueBufferExists(stores, platform, externalUserId), true);
  assert.equal(
    (await stores.clarification.get(`${platform}:${externalUserId}`)) !== null,
    true,
  );
  if (stores.displayName) {
    assert.equal(
      (await stores.displayName.get(userId))?.displayName,
      'Privacy Drill',
    );
  }
}

async function assertRedisStateAbsent(
  platform,
  stores,
  externalUserId,
  userId,
) {
  assert.equal((await stores.history.getHistory(externalUserId)).length, 0);
  assert.equal(
    await queueBufferExists(stores, platform, externalUserId),
    false,
  );
  assert.equal(
    await stores.clarification.get(`${platform}:${externalUserId}`),
    null,
  );
  if (stores.displayName)
    assert.equal(await stores.displayName.get(userId), null);
}

async function cleanupRedisState(platform, stores, externalUserId, userId) {
  await stores.history.clear(externalUserId);
  await stores.queue.clearChatBuffer(externalUserId);
  await stores.clarification.clear(`${platform}:${externalUserId}`);
  await stores.displayName?.del(userId);
}

// Keep key assertions on the real queue's per-user buffer.
async function queueBufferExists(stores, platform, externalUserId) {
  return (
    (await stores.client.exists(queueBufferKey(platform, externalUserId))) === 1
  );
}

function queueBufferKey(platform, externalUserId) {
  return platform === 'messenger'
    ? `chat:queue:buffer:${externalUserId}`
    : `chat:queue:${platform}:buffer:${externalUserId}`;
}
