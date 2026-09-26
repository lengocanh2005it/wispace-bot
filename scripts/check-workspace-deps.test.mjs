import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { checkWorkspaceDeps } from './check-workspace-deps.mjs';

const ROOT_MANIFEST = JSON.stringify({
  name: 'root',
  private: true,
  workspaces: ['apps/*', 'packages/*'],
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wispace-workspace-deps-'));
  writeFileSync(join(root, 'package.json'), ROOT_MANIFEST);
  mkdirSync(join(root, 'apps', 'demo', 'src'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  return {
    root,
    manifest(relativePath, fields) {
      const file = join(root, relativePath, 'package.json');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ name: `@wispace/${relativePath}`, ...fields }));
    },
    write(relativePath, source) {
      const file = join(root, relativePath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('an undeclared workspace import is reported with file and line', () => {
  const f = fixture();
  try {
    f.manifest('apps/demo', { dependencies: { '@nestjs/common': '^12' } });
    f.write('apps/demo/src/service.ts', "import { runBatched } from '@wispace/scheduler-core/core';\n");

    const { violations, workspacesChecked } = checkWorkspaceDeps(f.root);

    assert.equal(workspacesChecked, 1);
    assert.deepEqual(violations, [
      {
        package: 'apps/demo',
        name: '@wispace/apps/demo',
        imported: '@wispace/scheduler-core',
        subpath: '/core',
        file: 'apps/demo/src/service.ts',
        line: 1,
        typeOnly: false,
      },
    ]);
  } finally {
    f.close();
  }
});

test('a declared workspace import produces no violation', () => {
  const f = fixture();
  try {
    f.manifest('apps/demo', { dependencies: { '@wispace/scheduler-core': '*' } });
    f.write('apps/demo/src/service.ts', "import { runBatched } from '@wispace/scheduler-core/core';\n");

    assert.deepEqual(checkWorkspaceDeps(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('a devDependency counts as declared', () => {
  const f = fixture();
  try {
    f.manifest('apps/demo', { devDependencies: { '@wispace/chat-pipeline': '*' } });
    f.write('apps/demo/test/spec.ts', "import { ChatPipeline } from '@wispace/chat-pipeline';\n");

    assert.deepEqual(checkWorkspaceDeps(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('a type-only import of an undeclared package is reported as type-only', () => {
  const f = fixture();
  try {
    f.manifest('apps/demo', {});
    f.write('apps/demo/src/port.ts', "import type { Platform } from '@wispace/contracts';\n");

    const { violations } = checkWorkspaceDeps(f.root);

    assert.equal(violations.length, 1);
    assert.equal(violations[0].typeOnly, true);
    assert.equal(violations[0].imported, '@wispace/contracts');
    assert.equal(violations[0].subpath, '(root)');
  } finally {
    f.close();
  }
});

test('dynamic import and require are both caught', () => {
  const f = fixture();
  try {
    f.manifest('apps/demo', {});
    f.write('apps/demo/src/dynamic.ts', "export const load = () => import('@wispace/chat-agent');\n");
    f.write('apps/demo/src/legacy.mjs', "const { x } = require('@wispace/date-utils');\n");

    const { violations } = checkWorkspaceDeps(f.root);

    assert.deepEqual(
      violations.map((v) => v.imported).sort(),
      ['@wispace/chat-agent', '@wispace/date-utils'],
    );
  } finally {
    f.close();
  }
});

test('a commented-out import is not a violation', () => {
  const f = fixture();
  try {
    f.manifest('apps/demo', {});
    f.write('apps/demo/src/a.ts', "// import { X } from '@wispace/chat-agent';\n");
    f.write('apps/demo/src/b.ts', "/*\nimport { Y } from '@wispace/chat-agent';\n*/\nexport {};\n");

    assert.deepEqual(checkWorkspaceDeps(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('a URL in a string does not truncate the rest of the line', () => {
  const f = fixture();
  try {
    f.manifest('apps/demo', {});
    f.write(
      'apps/demo/src/config.ts',
      "export const url = 'https://example.internal/api'; // see internal wiki\nexport {};\n",
    );
    f.write('apps/demo/src/after.ts', "export { z } from '@wispace/date-utils';\n");

    const { violations } = checkWorkspaceDeps(f.root);

    assert.equal(violations.length, 1);
    assert.equal(violations[0].imported, '@wispace/date-utils');
  } finally {
    f.close();
  }
});

test('an undeclared third-party package is out of scope', () => {
  const f = fixture();
  try {
    f.manifest('apps/demo', {});
    f.write('apps/demo/src/a.ts', "import Stripe from 'stripe';\n");

    assert.deepEqual(checkWorkspaceDeps(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('root scripts are not scanned', () => {
  const f = fixture();
  try {
    f.manifest('apps/demo', { dependencies: { '@wispace/contracts': '*' } });
    f.write('scripts/smoke.mjs', "import { Platform } from '@wispace/contracts';\n");
    f.write('scripts/deploy.mjs', "import { a } from '@wispace/chat-agent';\n");

    assert.deepEqual(checkWorkspaceDeps(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('node_modules and dist are skipped', () => {
  const f = fixture();
  try {
    f.manifest('apps/demo', {});
    f.write('apps/demo/node_modules/thing/index.js', "import { a } from '@wispace/chat-agent';\n");
    f.write('apps/demo/dist/index.js', "import { b } from '@wispace/chat-agent';\n");

    assert.deepEqual(checkWorkspaceDeps(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('several violations in one file are each reported once', () => {
  const f = fixture();
  try {
    f.manifest('apps/demo', {});
    f.write(
      'apps/demo/src/many.ts',
      [
        "import { a } from '@wispace/chat-agent';",
        "import { b } from '@wispace/chat-agent';",
        "import { c } from '@wispace/date-utils';",
        '',
      ].join('\n'),
    );

    const { violations } = checkWorkspaceDeps(f.root);

    assert.equal(violations.length, 3);
    assert.deepEqual(
      violations.map((v) => `${v.imported}:${v.line}`),
      ['@wispace/chat-agent:1', '@wispace/chat-agent:2', '@wispace/date-utils:3'],
    );
  } finally {
    f.close();
  }
});

test('a workspace without a wispace scope name is skipped', () => {
  const f = fixture();
  try {
    const file = join(f.root, 'packages', 'legacy', 'package.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ name: 'legacy-tool' }));
    f.write('packages/legacy/src/a.ts', "import { a } from '@wispace/chat-agent';\n");

    assert.deepEqual(checkWorkspaceDeps(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('the checker script is a valid node program', () => {
  const source = readFileSync(new URL('./check-workspace-deps.mjs', import.meta.url), 'utf8');
  assert.match(source, /export function checkWorkspaceDeps/);
  assert.match(source, /process\.exitCode = 1/);
});
