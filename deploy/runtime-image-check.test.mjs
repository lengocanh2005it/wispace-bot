import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { buildRuntimeCheck } from './runtime-image-check.mjs';

const APP = 'demo';
const CHECK = buildRuntimeCheck();

/**
 * A tree that satisfies every check the program makes: the app entrypoint, a
 * loadable @wispace package, and an otherwise clean node_modules. Each test
 * then adds one directory and asserts what the program does about it.
 */
function image(entries) {
  const root = mkdtempSync(join(tmpdir(), 'wispace-runtime-image-'));
  const file = (relative, body) => {
    const full = join(root, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };
  file(`apps/${APP}/dist/main.js`, 'module.exports = {};\n');
  file('node_modules/@wispace/bot-common/dist/index.js', 'module.exports = 1;\n');
  file(
    'node_modules/@wispace/bot-common/package.json',
    '{"name":"@wispace/bot-common"}\n',
  );
  for (const [relative, body] of entries) file(relative, body);
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** Run the exact program the image check ships, against a fixture root. */
function runCheck(root) {
  const result = spawnSync(process.execPath, ['-e', CHECK, APP, root], {
    encoding: 'utf8',
  });
  return { status: result.status, output: (result.stderr || '') + result.stdout };
}

/** Reported paths are host-absolute, so match on separators-independently. */
function reportsPath(output, suffix) {
  const normalized = output.split('\\').join('/');
  assert.match(normalized, new RegExp(suffix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
}

test('a clean runtime tree passes', () => {
  const f = image([['node_modules/@wispace/contracts/dist/index.js', 'module.exports = 2;\n']]);
  try {
    const { status, output } = runCheck(f.root);
    assert.equal(status, 0, output);
    assert.match(output, /dev-only toolchain absent/);
  } finally {
    f.close();
  }
});

test('an unscoped toolchain directory is reported', () => {
  const f = image([['node_modules/typescript/package.json', '{}\n']]);
  try {
    const { status, output } = runCheck(f.root);
    assert.equal(status, 1);
    assert.match(output, /Dev-only packages in runtime image/);
    reportsPath(output, 'node_modules/typescript');
  } finally {
    f.close();
  }
});

test('a scoped build-only package is reported by its full name', () => {
  // The defect this pins: the walk used to match only the last path segment, so
  // `@nestjs/cli` presented as `cli` and adding its name to the forbidden set
  // produced a guard that could never fire while CI stayed green.
  const f = image([['node_modules/@nestjs/cli/package.json', '{}\n']]);
  try {
    const { status, output } = runCheck(f.root);
    assert.equal(status, 1, 'a scoped forbidden name must be detected');
    reportsPath(output, 'node_modules/@nestjs/cli');
  } finally {
    f.close();
  }
});

test('a nested toolchain directory is not matched by its bare directory name', () => {
  // Deliberate: the alias TypeScript copy is not in the forbidden list. It leaves
  // the runtime closure because its declaring package does, and `typescript` is
  // too generic a directory name to blacklist on its own. Matching is relative
  // to the node_modules root, so a nested copy is out of scope by design.
  const f = image([
    ['node_modules/@wispace/wispace-client/node_modules/typescript/package.json', '{}\n'],
    ['node_modules/@wispace/wispace-client/dist/index.js', 'module.exports = 4;\n'],
    ['node_modules/@wispace/wispace-client/package.json', '{"name":"@wispace/wispace-client"}\n'],
  ]);
  try {
    assert.equal(runCheck(f.root).status, 0);
  } finally {
    f.close();
  }
});

test('a non-forbidden scoped package is not reported', () => {
  const f = image([['node_modules/@nestjs/common/index.js', 'module.exports = 3;\n']]);
  try {
    assert.equal(runCheck(f.root).status, 0);
  } finally {
    f.close();
  }
});

test('a missing runtime artifact still fails the check', () => {
  const f = image([]);
  try {
    rmSync(join(f.root, 'apps', APP), { recursive: true, force: true });
    const { status, output } = runCheck(f.root);
    assert.equal(status, 1);
    assert.match(output, /Missing runtime artifact/);
  } finally {
    f.close();
  }
});

test('an unloadable workspace package still fails the check', () => {
  const f = image([
    ['node_modules/@wispace/broken/dist/index.js', "throw new Error('boom');\n"],
    ['node_modules/@wispace/broken/package.json', '{"name":"@wispace/broken"}\n'],
  ]);
  try {
    const { status, output } = runCheck(f.root);
    assert.equal(status, 1);
    assert.match(output, /Unloadable workspace packages/);
  } finally {
    f.close();
  }
});
