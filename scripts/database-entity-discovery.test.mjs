import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  assertEntitiesRegistered,
  discoverCompiledEntities,
} from './database-entity-discovery.mjs';

const require = createRequire(import.meta.url);
const rootDir = resolve(import.meta.dirname, '..');

const minimalEnv = {
  NODE_ENV: 'test',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_USER: 'test',
  DB_PASSWORD: 'test',
  DB_NAME: 'test',
};

test('discovers compiled platform entities without a maintained allowlist', () => {
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
  const config = new ConfigService(minimalEnv);

  for (const [platform, app, database] of [
    ['discord', 'discord-bot', discordDatabase],
    ['zalo', 'zalo-bot', zaloDatabase],
  ]) {
    const discovered = discoverCompiledEntities({ rootDir, app });
    const options = database.buildTypeOrmOptions(config);

    assertEntitiesRegistered(options, discovered, platform);
    assert.ok(discovered.length > 0);
    assert.ok(
      discovered.every(
        ({ file }) =>
          !file.endsWith('.spec.js') && !file.includes('.transformer.'),
      ),
    );
  }
});

test('reports discovered entities missing from production TypeORM options', () => {
  const discovered = [
    {
      name: 'DiscordAccountLinkEntity',
      file: 'discord-account-link.entity.js',
      entity: class DiscordAccountLinkEntity {},
    },
  ];

  assert.throws(
    () => assertEntitiesRegistered({ entities: [] }, discovered, 'discord'),
    /discord: compiled TypeORM entities are not registered.*DiscordAccountLinkEntity.*discord-account-link\.entity\.js/i,
  );
});
