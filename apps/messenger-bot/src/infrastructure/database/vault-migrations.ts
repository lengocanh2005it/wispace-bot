import { spawn } from 'node:child_process';
import { loadVaultSecrets } from '@wispace/bot-common/secrets';
import type { DataSource } from 'typeorm';

const SILENT_LOGGER = {
  log: () => undefined,
  warn: () => undefined,
};

type MigrationMode = 'preflight' | 'run' | 'show';

function readRequiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`missing ${key}`);
  return value;
}

async function assertWritablePrimary(source: DataSource): Promise<void> {
  const rows = (await source.query(
    'SELECT NOT pg_is_in_recovery() AS writable',
  )) as Array<{ writable?: boolean | string }>;
  const writable = rows[0]?.writable;
  if (writable !== true && writable !== 't') {
    throw new Error('database endpoint is not a writable primary');
  }
}

async function writePreMigrationDump(): Promise<void> {
  const args = [
    '-U',
    readRequiredEnv('DB_USER'),
    '-d',
    readRequiredEnv('DB_NAME'),
    '-h',
    readRequiredEnv('DB_HOST'),
    '-p',
    process.env.DB_PORT?.trim() || '5432',
    '-Fc',
  ];
  const password = readRequiredEnv('DB_PASSWORD');

  const child = spawn('pg_dump', args, {
    env: { ...process.env, PGPASSWORD: password },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', () => reject(new Error('pre-migration dump failed')));
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) throw new Error('pre-migration dump failed');
}

async function run(mode: MigrationMode): Promise<void> {
  await loadVaultSecrets({ application: 'messenger', logger: SILENT_LOGGER });
  const dataSourceModule = (await import('./data-source.js')) as unknown as {
    default: DataSource;
  };
  const dataSource = dataSourceModule.default;
  await dataSource.initialize();
  try {
    if (mode === 'preflight') {
      await assertWritablePrimary(dataSource);
      await dataSource.destroy();
      await writePreMigrationDump();
      return;
    }
    if (mode === 'run') {
      await dataSource.runMigrations();
      return;
    }
    const hasPending = await dataSource.showMigrations();
    process.stdout.write(hasPending ? '[ ] pending\n' : '[X] applied\n');
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

const mode = process.argv[2] as MigrationMode | undefined;
if (mode !== 'preflight' && mode !== 'run' && mode !== 'show') {
  console.error('Vault migration mode is invalid');
  process.exitCode = 1;
} else {
  run(mode).catch(() => {
    console.error('Vault migration command failed');
    process.exitCode = 1;
  });
}
