import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildVerifyPlan,
  parseVerifyOptions,
  ROOT_VERIFY_SCRIPTS,
} from './verify.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) =>
  JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));

test('root verify entry points share one runner and only select a mode', () => {
  const { scripts } = readJson('package.json');
  assert.equal(scripts.verify, 'node scripts/verify.mjs');
  assert.equal(
    scripts['verify:affected'],
    'node scripts/verify.mjs --affected',
  );

  const full = buildVerifyPlan();
  const affected = buildVerifyPlan({ affected: true });
  const forced = buildVerifyPlan({ force: true });
  assert.deepEqual(full.slice(0, -1), affected.slice(0, -1));
  assert.deepEqual(full.slice(0, -1), forced.slice(0, -1));
  assert.deepEqual(full.at(-1).args, [
    '--no-install',
    'turbo',
    'run',
    'typecheck',
    'test',
    'build',
  ]);
  assert.deepEqual(affected.at(-1).args, [
    '--no-install',
    'turbo',
    'run',
    'typecheck',
    'test',
    'build',
    '--affected',
  ]);
  assert.deepEqual(forced.at(-1).args, [
    '--no-install',
    'turbo',
    'run',
    'typecheck',
    'test',
    'build',
    '--force',
  ]);
  assert.deepEqual(
    buildVerifyPlan(parseVerifyOptions(['--cache=local:rw,remote:r'])).at(-1)
      .args,
    [
      '--no-install',
      'turbo',
      'run',
      'typecheck',
      'test',
      'build',
      '--cache=local:rw,remote:r',
    ],
  );
  assert.deepEqual(
    buildVerifyPlan(parseVerifyOptions(['--cache-dir=/tmp/turbo-cache'])).at(-1)
      .args,
    [
      '--no-install',
      'turbo',
      'run',
      'typecheck',
      'test',
      'build',
      '--cache-dir=/tmp/turbo-cache',
    ],
  );
  assert.throws(() => parseVerifyOptions(['--typo']), /Unknown verify option/);
});

test('the root gate owns all workspace verification scripts', () => {
  const turbo = readJson('turbo.json');
  assert.equal(
    turbo.tasks.verify,
    undefined,
    'Turbo must not define a second verify task',
  );

  for (const directory of ['apps', 'packages']) {
    for (const name of readdirSync(resolve(ROOT, directory))) {
      const path = `${directory}/${name}/package.json`;
      const { scripts = {} } = readJson(path);
      assert.equal(
        scripts.verify,
        undefined,
        `${path} must not shadow the root verify gate`,
      );
    }
  }
});

test('the shared root gate includes each CI guard test and check once', () => {
  for (const script of [
    'architecture:test',
    'redis-usage:test',
    'metric-registry:test',
    'workspace-deps:test',
    'manifest-deps:test',
    'dep-versions:test',
    'entrypoint-consumers:test',
    'runtime-image:test',
    'prove-checks:test',
    'file-size:test',
    'workspace-deps:check',
    'manifest-deps:check',
    'dep-versions:check',
    'file-size:check',
    'architecture:check',
    'redis-usage:check',
    'metric-registry:check',
    'format:check',
    'lint',
    'knip:deps',
  ]) {
    assert.equal(
      ROOT_VERIFY_SCRIPTS.filter((item) => item === script).length,
      1,
      script,
    );
  }
  assert.ok(ROOT_VERIFY_SCRIPTS.includes('verify:definition:test'));
});

test('CI routes PR, push, and scheduled verification through the root gate', () => {
  const workflow = readFileSync(
    resolve(ROOT, '.github/workflows/pull-request.yml'),
    'utf8',
  );
  assert.match(workflow, /run: npm run verify:affected/);
  assert.match(workflow, /run: npm run verify\n/);
  assert.match(workflow, /run: npm run verify -- --force/);
  assert.doesNotMatch(workflow, /turbo run (?:format:check|verify)/);

  const verifyJob = workflow.match(
    /^  verify:\n([\s\S]*?)(?=^  http-contract-test:)/m,
  )?.[1];
  assert.ok(verifyJob, 'verification job must exist');
  const commands = [...verifyJob.matchAll(/^\s+run:\s*(.+)$/gm)].map((match) =>
    match[1].trim(),
  );
  assert.deepEqual(commands, [
    'npm ci',
    'npm run verify:affected',
    'npm run verify',
    'npm run verify -- --force',
  ]);
});
