import 'reflect-metadata';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  assertEntitiesRegistered,
  discoverCompiledEntities,
} from './database-entity-discovery.mjs';

const require = createRequire(import.meta.url);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { ConfigService } = require('@nestjs/config');
const { DataSource, In } = require('typeorm');
const {
  CleanupCronService,
  PlatformCleanupCronService,
} = require('@wispace/cleanup-cron');
const { PgAdvisoryLockService } = require('@wispace/bot-common/locks');

const requiredEnv = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const migrationMode = process.argv.includes('--migrations');
const checkName = migrationMode
  ? 'database migration compatibility'
  : 'database bootstrap smoke';
for (const key of requiredEnv) {
  if (!process.env[key]?.trim()) {
    throw new Error(`${checkName} requires ${key}`);
  }
}
if (
  process.env.NODE_ENV !== 'test' ||
  !['127.0.0.1', 'localhost', '::1'].includes(
    process.env.DB_HOST.trim().toLowerCase(),
  )
) {
  throw new Error(`${checkName} requires NODE_ENV=test and a loopback DB_HOST`);
}

const config = new ConfigService({ ...process.env });

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

const discordEntities = discoverCompiledEntities({
  rootDir,
  app: 'discord-bot',
});
const zaloEntities = discoverCompiledEntities({ rootDir, app: 'zalo-bot' });

function ephemeralOptions(builder, dropSchema) {
  const options = {
    ...builder(config),
    dropSchema,
    logging: false,
  };
  // ponytail: synchronize is limited to this disposable CI database; migration compatibility is a separate mode.
  return migrationMode
    ? { ...options, synchronize: false }
    : { ...options, synchronize: true, migrations: [] };
}

function assertMetadata(dataSource, entities, platform) {
  for (const { name, entity } of entities) {
    const metadata = dataSource.getMetadata(entity);
    if (metadata.target !== entity || !metadata.tableName) {
      throw new Error(
        `${platform}: discovered entity ${name} has incomplete TypeORM metadata`,
      );
    }
  }
}

async function assertTables(dataSource, entities, platform) {
  const queryRunner = dataSource.createQueryRunner();
  try {
    const tables = new Map(
      entities.map(({ entity, name }) => {
        const metadata = dataSource.getMetadata(entity);
        return [metadata.tableName, name];
      }),
    );
    for (const [table, name] of tables) {
      if (!(await queryRunner.hasTable(table))) {
        throw new Error(
          `${platform}: migration schema is missing ${table} for ${name}`,
        );
      }
    }
  } finally {
    await queryRunner.release();
  }
}

async function exerciseCleanup({
  dataSource,
  platform,
  envPrefix,
  oauthEntity,
  lockId,
}) {
  const repo = dataSource.getRepository(oauthEntity.entity);
  const suffix = randomUUID().replaceAll('-', '');
  const oldState = `old-${suffix}`;
  const freshState = `fresh-${suffix}`;
  const oldCreatedAt = new Date(Date.now() - 11 * 60_000);
  const freshCreatedAt = new Date();
  const oldValues = {
    state: oldState,
    linkToken: 'smoke-test-link-token',
    createdAt: oldCreatedAt,
  };
  const freshValues = {
    state: freshState,
    linkToken: 'smoke-test-link-token',
    createdAt: freshCreatedAt,
  };

  const hasCodeVerifier = dataSource
    .getMetadata(oauthEntity.entity)
    .columns.some(({ propertyName }) => propertyName === 'codeVerifier');
  if (hasCodeVerifier) {
    oldValues.codeVerifier = 'smoke-test-code-verifier';
    freshValues.codeVerifier = 'smoke-test-code-verifier';
  }

  await repo.insert([oldValues, freshValues]);

  const cleanup = new CleanupCronService(
    dataSource,
    new PgAdvisoryLockService(dataSource),
  );
  const platformCleanup = new PlatformCleanupCronService(
    cleanup,
    config,
    dataSource,
    {
      platform,
      envPrefix,
      lockIds: { oauthState: lockId },
      messageLogRepo: repo,
      deadLetterRepo: repo,
      idempotencyRepo: repo,
      rateLimitService: {
        isEnabled: () => false,
        recoverStuckReservedSlots: async () => ({ recovered: [] }),
      },
      oauthStateRepo: repo,
    },
  );

  await platformCleanup.handleOAuthStateCleanup();

  const remaining = await repo.findBy({ state: In([oldState, freshState]) });
  const states = new Set(remaining.map((row) => row.state));
  if (
    remaining.length !== 1 ||
    !states.has(freshState) ||
    states.has(oldState)
  ) {
    throw new Error(
      `${platform}: OAuth cleanup did not delete exactly the stale row`,
    );
  }
}

function findOAuthStateEntity(dataSource, entities, platform) {
  const candidates = entities.filter(({ entity }) =>
    dataSource.getMetadata(entity).tableName.endsWith('_oauth_states'),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `${platform}: expected exactly one discovered OAuth state entity, found ${candidates.length}`,
    );
  }
  return candidates[0];
}

async function runCanonicalMigrations() {
  const messengerDatabase = require(
    resolve(
      rootDir,
      'apps/messenger-bot/dist/infrastructure/database/data-source.js',
    ),
  );
  const dataSource = new DataSource({
    ...messengerDatabase.default.options,
    dropSchema: true,
    synchronize: false,
    logging: false,
  });
  try {
    await dataSource.initialize();
    if (!(await dataSource.showMigrations())) {
      throw new Error('fresh database has no pending migrations');
    }
    await dataSource.runMigrations();
    if (await dataSource.showMigrations()) {
      throw new Error('migrations remain pending after run');
    }
    console.log('messenger: migration chain passed');
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

async function assertNoPendingMigrations(dataSource, platform) {
  if (await dataSource.showMigrations()) {
    throw new Error(
      `${platform}: migrations remain pending after canonical run`,
    );
  }
}

async function runPlatform({
  platform,
  envPrefix,
  builder,
  entities,
  lockId,
  dropSchema,
}) {
  const options = ephemeralOptions(builder, dropSchema);
  assertEntitiesRegistered(options, entities, platform);
  const dataSource = new DataSource(options);
  try {
    await dataSource.initialize();
    assertMetadata(dataSource, entities, platform);
    if (migrationMode) {
      await assertNoPendingMigrations(dataSource, platform);
      await assertTables(dataSource, entities, platform);
      console.log(`${platform}: metadata and migrations passed`);
    } else {
      await exerciseCleanup({
        dataSource,
        platform,
        envPrefix,
        oauthEntity: findOAuthStateEntity(dataSource, entities, platform),
        lockId,
      });
      console.log(`${platform}: metadata and OAuth cleanup passed`);
    }
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

if (migrationMode) await runCanonicalMigrations();

await runPlatform({
  platform: 'discord',
  envPrefix: 'DISCORD_',
  builder: discordDatabase.buildTypeOrmOptions,
  entities: discordEntities,
  lockId: 884_200_939,
  dropSchema: !migrationMode,
});

await runPlatform({
  platform: 'zalo',
  envPrefix: 'ZALO_',
  builder: zaloDatabase.buildTypeOrmOptions,
  entities: zaloEntities,
  lockId: 884_200_913,
  dropSchema: false,
});
