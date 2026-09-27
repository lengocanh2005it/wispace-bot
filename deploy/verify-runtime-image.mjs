import { spawnSync } from 'node:child_process';

import { buildRuntimeCheck } from './runtime-image-check.mjs';

const image = process.argv[2];
const appName = process.argv[3] ?? 'messenger-bot';

if (!image || !/^[A-Za-z0-9._/@:-]+$/.test(image)) {
  throw new Error(
    'Usage: node deploy/verify-runtime-image.mjs IMAGE [APP_NAME]',
  );
}
if (!/^[a-z0-9-]+$/.test(appName)) {
  throw new Error(
    'APP_NAME must contain lowercase letters, digits, or hyphens',
  );
}

function run(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() || 'docker exited with ' + result.status,
    );
  }
  return result.stdout.trim();
}

const sizeBytes = Number(
  run(['image', 'inspect', '--format={{.Size}}', image]),
);
if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
  throw new Error('Could not read image size for ' + image);
}

run([
  'run',
  '--rm',
  '--entrypoint',
  'node',
  image,
  '-e',
  buildRuntimeCheck(),
  appName,
]);
console.log(
  'runtime image ' +
    image +
    ': ' +
    sizeBytes +
    ' bytes (' +
    (sizeBytes / 1024 / 1024).toFixed(1) +
    ' MiB)',
);
