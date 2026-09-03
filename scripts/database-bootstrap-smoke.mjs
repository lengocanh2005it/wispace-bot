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
const { PlatformDeadLetterService, WebhookDeadLetterEntity } = require(
  '@wispace/database',
);

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

/**
 * Every column an entity maps must exist in the migrated schema. This is the
 * check that would have caught #711 — `PlatformDeadLetterService` read/wrote
 * `lease_token` / `lease_expires_at` on `webhook_dead_letters` for months while
 * no migration created them and `assertTables` (table-level only) stayed green.
 * Entity -> DB direction only: a migration may add columns an entity does not
 * map yet (persistence-only state), but an entity column with no DB column is
 * always drift.
 */
async function assertColumns(dataSource, platform) {
  const queryRunner = dataSource.createQueryRunner();
  const drift = [];
  try {
    for (const metadata of dataSource.entityMetadatas) {
      if (metadata.tableType === 'view') continue;
      const table = await queryRunner.getTable(metadata.tableName);
      if (!table) continue; // table presence is assertTables' concern
      const present = new Set(table.columns.map((column) => column.name));
      for (const column of metadata.columns) {
        if (!present.has(column.databaseName)) {
          drift.push(
            `${metadata.tableName}.${column.databaseName} (entity ${metadata.name})`,
          );
        }
      }
    }
  } finally {
    await queryRunner.release();
  }
  if (drift.length > 0) {
    throw new Error(
      `${platform}: entity columns missing from the migrated schema:\n  ${drift.join('\n  ')}`,
    );
  }
}

/**
 * Exercises the crash-safe dead-letter replay path against real Postgres on the
 * migrated schema: the lease-fenced claim/mark flow (#291) that silently threw
 * in production because its columns were never migrated (#711). Covers the
 * claim + all three terminal writes (`markReplayed`, `incrementRetry`,
 * `markAbandoned`), the stale-token negative, the double-claim guard, and the
 * empty-table no-op the retry cron relies on.
 */
async function exerciseDeadLetterReplay(dataSource) {
  const LEASE_MS = 600_000;
  const repo = dataSource.getRepository(WebhookDeadLetterEntity);
  const service = new PlatformDeadLetterService('messenger', repo);
  const owner = `dl-smoke-${randomUUID().replaceAll('-', '')}`;

  const seedPendingOutbound = async () => {
    const saved = await repo.save({
      platform: 'messenger',
      externalUserId: owner,
      direction: 'outbound',
      rawPayload: { text: 'smoke' },
      errorMessage: 'smoke send failed',
      status: 'pending',
    });
    return saved.id;
  };

  // The retry cron must no-op cleanly when nothing is pending (#711 AC5).
  const emptyScan = await service.listPendingForRetry({
    limit: 10,
    olderThan: new Date(),
    maxRetries: 3,
  });
  if (emptyScan.length !== 0) {
    throw new Error(
      `listPendingForRetry returned ${emptyScan.length} rows against a fresh schema`,
    );
  }

  try {
    // Positive: claim assigns a lease + delivery key; the owner completes the row.
    const id1 = await seedPendingOutbound();
    const claim1 = await service.claimForRetry(id1, LEASE_MS);
    if (!claim1?.leaseToken || !claim1?.deliveryKey) {
      throw new Error('claimForRetry did not assign a lease token / delivery key');
    }
    if (
      !(await service.markReplayed(id1, claim1.leaseToken, claim1.deliveryKey))
    ) {
      throw new Error('markReplayed rejected the lease owner');
    }
    const row1 = await repo.findOneBy({ id: id1 });
    if (row1?.status !== 'replayed') {
      throw new Error(`expected status 'replayed', got '${row1?.status}'`);
    }

    // Negative: a stale lease token cannot mark; the real owner still can.
    const id2 = await seedPendingOutbound();
    const claim2 = await service.claimForRetry(id2, LEASE_MS);
    if (!claim2) throw new Error('second claimForRetry returned null');
    if (await service.markReplayed(id2, randomUUID(), claim2.deliveryKey)) {
      throw new Error('a stale lease token was allowed to mark the row');
    }
    if (
      !(await service.markReplayed(id2, claim2.leaseToken, claim2.deliveryKey))
    ) {
      throw new Error('the real owner could not mark after a stale attempt');
    }

    // incrementRetry: the lease owner re-opens the row and clears the lease.
    const id3 = await seedPendingOutbound();
    const claim3 = await service.claimForRetry(id3, LEASE_MS);
    if (!claim3) throw new Error('claimForRetry for incrementRetry returned null');
    if (await service.incrementRetry(id3, 'retry', owner, { leaseToken: randomUUID() })) {
      throw new Error('incrementRetry accepted a stale lease token');
    }
    if (
      !(await service.incrementRetry(id3, 'retry', owner, {
        leaseToken: claim3.leaseToken,
      }))
    ) {
      throw new Error('incrementRetry rejected the lease owner');
    }
    const row3 = await repo.findOneBy({ id: id3 });
    if (
      row3?.status !== 'pending' ||
      row3.retryCount !== 1 ||
      row3.leaseToken !== null ||
      row3.leaseExpiresAt !== null
    ) {
      throw new Error(
        `incrementRetry left the row in a bad state: ${JSON.stringify(row3)}`,
      );
    }

    // markAbandoned: the lease owner terminalizes the row.
    const id4 = await seedPendingOutbound();
    const claim4 = await service.claimForRetry(id4, LEASE_MS);
    if (!claim4) throw new Error('claimForRetry for markAbandoned returned null');
    if (
      await service.markAbandoned(id4, 'stale', owner, {
        leaseToken: randomUUID(),
      })
    ) {
      throw new Error('markAbandoned accepted a stale lease token');
    }
    if (
      !(await service.markAbandoned(id4, 'gave up', owner, {
        leaseToken: claim4.leaseToken,
      }))
    ) {
      throw new Error('markAbandoned rejected the lease owner');
    }
    const row4 = await repo.findOneBy({ id: id4 });
    if (row4?.status !== 'abandoned') {
      throw new Error(`expected status 'abandoned', got '${row4?.status}'`);
    }

    // A processing row cannot be claimed twice.
    const id5 = await seedPendingOutbound();
    const claim5a = await service.claimForRetry(id5, LEASE_MS);
    const claim5b = await service.claimForRetry(id5, LEASE_MS);
    if (!claim5a || claim5b !== null) {
      throw new Error('a processing row was claimed a second time');
    }
  } finally {
    await repo.delete({ externalUserId: owner });
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
    await assertColumns(dataSource, 'messenger');
    await exerciseDeadLetterReplay(dataSource);
    console.log(
      'messenger: entity/schema column parity + dead-letter lease replay passed',
    );
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
      await assertColumns(dataSource, platform);
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
