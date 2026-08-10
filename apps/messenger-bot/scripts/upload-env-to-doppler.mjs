import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const project = process.env.DOPPLER_PROJECT ?? 'messenger-bot';
const sourcePath = process.argv[2] ?? '.env';

const skip = new Set([
  'DEPLOY_DIR',
  'DEPLOY_ENV_FILE',
  'DEPLOY_COMPOSE_FILE',
  'DEPLOY_UID',
  'DEPLOY_GID',
  'DOCKER_GID',
  'HOME',
  'DOPPLER_CONFIG',
  'DOPPLER_ENVIRONMENT',
  'DOPPLER_PROJECT',
  'DOPPLER_RUNTIME_TOKEN',
]);

function parseEnvFile(filePath) {
  const entries = new Map();
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const idx = trimmed.indexOf('=');
    if (idx <= 0) {
      continue;
    }

    const key = trimmed.slice(0, idx).trim();
    if (skip.has(key)) {
      continue;
    }

    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries.set(key, value);
  }

  return entries;
}

function writeEnvFile(filePath, entries) {
  const body = [...entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  fs.writeFileSync(filePath, `${body}\n`, { mode: 0o600 });
}

function buildConfigEntries(config, baseEntries) {
  const entries = new Map(baseEntries);

  if (config === 'dev') {
    entries.set('PORT', '3001');
    entries.delete('DOPPLER_RUNTIME_SYNC_ENABLED');
    return entries;
  }

  if (config === 'prd') {
    entries.set('PORT', '5007');
    entries.set('DOPPLER_RUNTIME_SYNC_ENABLED', 'true');
    return entries;
  }

  throw new Error(`Unsupported Doppler config: ${config}`);
}

function uploadConfig(config, baseEntries) {
  const entries = buildConfigEntries(config, baseEntries);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wispace-doppler-'));
  const tempPath = path.join(tempDir, `${config}.env`);

  writeEnvFile(tempPath, entries);

  try {
    execFileSync(
      'doppler',
      [
        'secrets',
        'upload',
        tempPath,
        '--project',
        project,
        '--config',
        config,
      ],
      { stdio: 'inherit' },
    );
    console.log(`Uploaded ${entries.size} secrets to ${project}/${config}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const baseEntries = parseEnvFile(sourcePath);
const configs = process.argv.slice(3);
const targets = configs.length > 0 ? configs : ['dev', 'prd'];

for (const config of targets) {
  uploadConfig(config, baseEntries);
}
