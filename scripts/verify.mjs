import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ROOT_VERIFY_SCRIPTS = [
  'verify:definition:test',
  'architecture:test',
  'redis-usage:test',
  'metric-registry:test',
  'workspace-deps:test',
  'manifest-deps:test',
  'entrypoint-consumers:test',
  'runtime-image:test',
  'prove-checks:test',
  'file-size:test',
  'workspace-deps:check',
  'manifest-deps:check',
  'file-size:check',
  'architecture:check',
  'redis-usage:check',
  'metric-registry:check',
  'format:check',
  'lint',
  'knip:deps',
];

export function buildVerifyPlan({
  affected = false,
  force = false,
  turboArgs: forwardedTurboArgs = [],
} = {}) {
  const turboCommandArgs = ['run', 'typecheck', 'test', 'build'];
  if (affected) turboCommandArgs.push('--affected');
  if (force) turboCommandArgs.push('--force');
  turboCommandArgs.push(...forwardedTurboArgs);

  return [
    ...ROOT_VERIFY_SCRIPTS.map((script) => ({
      command: 'npm',
      args: ['run', script],
    })),
    {
      command: 'npx',
      args: ['--no-install', 'turbo', ...turboCommandArgs],
    },
  ];
}

export function parseVerifyOptions(args) {
  const options = { affected: false, force: false };
  options.turboArgs = [];
  for (const arg of args) {
    if (arg === '--affected') options.affected = true;
    else if (arg === '--force') options.force = true;
    else if (arg.startsWith('--cache=') || arg.startsWith('--cache-dir=')) {
      options.turboArgs.push(arg);
    } else throw new Error(`Unknown verify option: ${arg}`);
  }
  return options;
}

function runVerify(args) {
  let options;
  try {
    options = parseVerifyOptions(args);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  const plan = buildVerifyPlan(options);
  for (const { command, args: commandArgs } of plan) {
    const result = spawnSync(command, commandArgs, {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    if (result.error) {
      process.stderr.write(
        `${command} failed to start: ${result.error.message}\n`,
      );
      return 1;
    }
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = runVerify(process.argv.slice(2));
}
