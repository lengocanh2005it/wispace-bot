import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { checkExportSubpathConsumers } from './check-export-subpath-consumers.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wispace-subpaths-'));
  const write = (relativePath, contents) => {
    const file = join(root, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };
  const publish = (name, subpaths) => {
    const exports = {};
    for (const [subpath, target] of Object.entries(subpaths)) {
      exports[subpath] = {
        import: target,
        types: target.replace(/\.js$/, '.d.ts'),
        require: target,
        default: target,
      };
    }
    write(
      `packages/${name}/package.json`,
      JSON.stringify({ name: `@wispace/${name}`, exports }),
    );
  };
  return {
    root,
    write,
    publish,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a subpath that publishes symbols nothing imports is reported', () => {
  const f = fixture();
  try {
    f.publish('demo', {
      './core': './dist/core/index.js',
      './adapters': './dist/adapters/index.js',
    });
    f.write('packages/demo/src/core/index.ts', 'export const policy = 1;\n');
    f.write(
      'packages/demo/src/adapters/index.ts',
      'export const wire = () => null;\n',
    );
    f.write(
      'apps/other/src/app.ts',
      "import { policy } from '@wispace/demo/core';\n",
    );

    const result = checkExportSubpathConsumers(f.root);

    assert.deepEqual(
      result.violations.map((v) => v.specifier),
      ['@wispace/demo/adapters'],
    );
    assert.equal(result.violations[0].package, 'demo');
  } finally {
    f.close();
  }
});

test('every declared subpath having a consumer reports nothing', () => {
  const f = fixture();
  try {
    f.publish('demo', {
      './core': './dist/core/index.js',
      './adapters': './dist/adapters/index.js',
    });
    f.write('packages/demo/src/core/index.ts', 'export const policy = 1;\n');
    f.write(
      'packages/demo/src/adapters/index.ts',
      'export const wire = () => null;\n',
    );
    f.write(
      'apps/other/src/app.ts',
      "import { policy } from '@wispace/demo/core';\nimport { wire } from '@wispace/demo/adapters';\n",
    );

    assert.deepEqual(checkExportSubpathConsumers(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('a spec is a real consumer of a subpath', () => {
  const f = fixture();
  try {
    f.publish('demo', { './adapters': './dist/adapters/index.js' });
    f.write(
      'packages/demo/src/adapters/index.ts',
      'export const wire = () => null;\n',
    );
    f.write(
      'packages/demo/src/adapters/index.spec.ts',
      "import { wire } from '@wispace/demo/adapters';\n",
    );

    assert.deepEqual(checkExportSubpathConsumers(f.root).violations, []);
  } finally {
    f.close();
  }
});

// The distinction the rule turns on: a subpath that publishes nothing cannot
// mislead a reader, because importing it yields nothing and the next person
// finds out immediately. One that publishes symbols nobody imports reads as a
// real API. `account-link-core/adapters` is the live case — a comment-only
// placeholder reserved for a migration in progress.
test('a subpath reserved with no exports is reported but not a violation', () => {
  const f = fixture();
  try {
    f.publish('demo', { './adapters': './dist/adapters/index.js' });
    f.write(
      'packages/demo/src/adapters/index.ts',
      '// reserved for a migration in progress\n',
    );

    const result = checkExportSubpathConsumers(f.root);

    assert.deepEqual(result.violations, []);
    assert.deepEqual(
      result.reserved.map((r) => r.specifier),
      ['@wispace/demo/adapters'],
    );
  } finally {
    f.close();
  }
});

test('a commented-out import is not a consumer', () => {
  const f = fixture();
  try {
    f.publish('demo', { './adapters': './dist/adapters/index.js' });
    f.write(
      'packages/demo/src/adapters/index.ts',
      'export const wire = () => null;\n',
    );
    f.write(
      'apps/other/src/app.ts',
      "// import { wire } from '@wispace/demo/adapters';\n",
    );

    assert.equal(checkExportSubpathConsumers(f.root).violations.length, 1);
  } finally {
    f.close();
  }
});

test('a package with no exports map is not this rule\'s business', () => {
  const f = fixture();
  try {
    f.write(
      'packages/demo/package.json',
      JSON.stringify({ name: '@wispace/demo', main: 'dist/index.js' }),
    );
    f.write('packages/demo/src/index.ts', 'export const a = 1;\n');

    assert.deepEqual(checkExportSubpathConsumers(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('an unresolvable subpath target is reported rather than assumed empty', () => {
  const f = fixture();
  try {
    f.publish('demo', { './adapters': './dist/adapters/index.js' });

    const result = checkExportSubpathConsumers(f.root);

    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0].reason, /cannot resolve/i);
  } finally {
    f.close();
  }
});