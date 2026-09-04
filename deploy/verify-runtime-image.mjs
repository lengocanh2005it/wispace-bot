import { spawnSync } from 'node:child_process';

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

const runtimeCheck = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const app = process.argv[1];',
  'const required = [',
  "  path.join('/app/apps', app, 'dist/main.js'),",
  "  '/app/node_modules/@wispace/bot-common/dist/index.js',",
  '];',
  "const forbiddenNames = new Set(['typescript', 'ts-node', 'jest']);",
  'const forbidden = [];',
  'function walk(dir) {',
  '  if (!fs.existsSync(dir)) return;',
  '  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {',
  '    const full = path.join(dir, entry.name);',
  '    if (entry.isDirectory() && forbiddenNames.has(entry.name)) forbidden.push(full);',
  "    if (entry.isDirectory() && entry.name !== '.cache') walk(full);",
  '  }',
  '}',
  'for (const file of required) {',
  "  if (!fs.existsSync(file)) throw new Error('Missing runtime artifact: ' + file);",
  '}',
  "walk('/app/node_modules');",
  "if (forbidden.length) throw new Error('Dev-only packages in runtime image: ' + forbidden.join(', '));",
  // Existence checks alone passed a broken image: npm nests a dependency
  // when the hoisted slot holds an incompatible version, and the runtime
  // image used to drop those nested trees, so @wispace/wispace-client shipped
  // without undici. Actually loading each package catches that class.
  "const scopeDir = '/app/node_modules/@wispace';",
  "const unloadable = [];",
  'for (const name of fs.readdirSync(scopeDir)) {',
  "  const entry = path.join(scopeDir, name, 'dist/index.js');",
  '  if (!fs.existsSync(entry)) continue;',
  '  try {',
  '    require(entry);',
  '  } catch (err) {',
  "    unloadable.push(name + ': ' + String(err.message).split(String.fromCharCode(10))[0]);",
  '  }',
  '}',
  "if (unloadable.length) throw new Error('Unloadable workspace packages in runtime image: ' + unloadable.join(' | '));",
  "console.log('runtime artifacts present, workspace packages loadable, dev-only toolchain absent');",
].join('\n');

run([
  'run',
  '--rm',
  '--entrypoint',
  'node',
  image,
  '-e',
  runtimeCheck,
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
