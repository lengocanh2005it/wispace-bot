import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { getMetadataArgsStorage } = require('typeorm');

const COMPILED_ENTITY_ARTIFACT = /\.((spec|test)|transformer)\.js$/i;

function isCompiledModule(file) {
  return (
    file.isFile() &&
    file.name.endsWith('.js') &&
    !COMPILED_ENTITY_ARTIFACT.test(file.name)
  );
}

function isTypeOrmEntity(value, tables) {
  return (
    typeof value === 'function' &&
    tables.some((table) => table.target === value)
  );
}

/**
 * Discover the TypeORM entities emitted by a platform build.
 *
 * Entity decorators register their targets in TypeORM's metadata storage. By
 * loading every compiled module in the platform entity directory and keeping
 * only decorated targets, helper/transformer/test artifacts are ignored
 * without maintaining a second entity allowlist.
 */
export function discoverCompiledEntities({ rootDir, app }) {
  const entityDir = resolve(
    rootDir,
    `apps/${app}/dist/infrastructure/database/entities`,
  );
  const tables = getMetadataArgsStorage().tables;
  const discovered = [];
  const seen = new Set();

  for (const file of readdirSync(entityDir, { withFileTypes: true })
    .filter(isCompiledModule)
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = resolve(entityDir, file.name);
    const moduleExports = require(filePath);

    for (const [exportName, value] of Object.entries(moduleExports)) {
      if (!isTypeOrmEntity(value, tables) || seen.has(value)) continue;
      seen.add(value);
      discovered.push({
        name: value.name || exportName,
        file: file.name,
        entity: value,
      });
    }
  }

  if (discovered.length === 0) {
    throw new Error(
      `${app}: no compiled TypeORM entities discovered in ${entityDir}`,
    );
  }

  return discovered;
}

/**
 * Ensure every compiled platform entity is part of the production TypeORM
 * options returned by that bot's DatabaseModule.
 */
export function assertEntitiesRegistered(options, discovered, platform) {
  const registered = Array.isArray(options?.entities) ? options.entities : [];
  const registeredSet = new Set(registered);
  const missing = discovered.filter(({ entity }) => !registeredSet.has(entity));

  if (missing.length > 0) {
    const details = missing
      .map(({ name, file }) => `${name} (${file})`)
      .join(', ');
    throw new Error(
      `${platform}: compiled TypeORM entities are not registered in production TypeORM options: ${details}. ` +
        'Add the entity to buildTypeOrmOptions and DatabaseModule.forFeature.',
    );
  }
}
