import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  checkManifestDeps,
  collectImportedPackages,
} from './check-manifest-deps.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wispace-manifest-deps-'));
  return {
    root,
    manifest(pkg, fields) {
      const file = join(root, 'packages', pkg, 'package.json');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({ name: `@wispace/${pkg}`, ...fields }),
      );
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

test('build-only tooling declared in dependencies is reported', () => {
  // The defect this change removes: the Nest CLI toolchain sat in
  // `dependencies` and was installed by `npm ci --omit=dev`.
  const f = fixture();
  try {
    f.manifest('demo', {
      dependencies: { '@nestjs/cli': '^12', typeorm: '^0.3' },
    });
    f.write(
      'packages/demo/src/data-source.ts',
      "import { DataSource } from 'typeorm';\n",
    );

    assert.deepEqual(checkManifestDeps(f.root).violations, [
      { package: 'demo', dependency: '@nestjs/cli' },
    ]);
  } finally {
    f.close();
  }
});

test('a package used only through jest.mock in a spec passes', () => {
  // Scans specs on purpose: a source-only scan reports this as unused.
  const f = fixture();
  try {
    f.manifest('demo', { dependencies: { '@nestjs/core': '^12' } });
    f.write(
      'packages/demo/src/bootstrap.spec.ts',
      "jest.mock('@nestjs/core', () => ({ NestFactory: {} }));\n",
    );

    assert.deepEqual(checkManifestDeps(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('a package used only through a barrel re-export passes', () => {
  const f = fixture();
  try {
    f.manifest('demo', { dependencies: { '@wispace/date-utils': '*' } });
    f.write(
      'packages/demo/src/index.ts',
      "export { formatDay } from '@wispace/date-utils';\n",
    );

    assert.deepEqual(checkManifestDeps(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('a genuine runtime import passes', () => {
  const f = fixture();
  try {
    f.manifest('demo', { dependencies: { helmet: '^8' } });
    f.write(
      'packages/demo/src/main.ts',
      "import helmet from 'helmet';\nexport default helmet;\n",
    );

    assert.deepEqual(checkManifestDeps(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('a type-only import counts as a use', () => {
  // The runtime declaration is load-bearing for @wispace/bot-common: NestJS
  // resolves the platform adapter with a dynamic import, so type-only reasoning
  // would remove a package the process cannot start without.
  const f = fixture();
  try {
    f.manifest('demo', { dependencies: { '@nestjs/platform-express': '^12' } });
    f.write(
      'packages/demo/src/port.ts',
      "import type { NestExpressApplication } from '@nestjs/platform-express';\nexport type App = NestExpressApplication;\n",
    );

    assert.deepEqual(checkManifestDeps(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('devDependencies are out of scope', () => {
  const f = fixture();
  try {
    f.manifest('demo', { devDependencies: { '@nestjs/cli': '^12' } });

    const result = checkManifestDeps(f.root);
    assert.deepEqual(result.violations, []);
    assert.equal(result.packagesChecked, 0);
  } finally {
    f.close();
  }
});

test('a subpath import satisfies the package declaration', () => {
  const f = fixture();
  try {
    f.manifest('demo', { dependencies: { '@wispace/llm-agent': '*' } });
    f.write(
      'packages/demo/src/agent.ts',
      "import { run } from '@wispace/llm-agent/core';\n",
    );

    assert.deepEqual(checkManifestDeps(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('a commented-out import does not satisfy a declaration', () => {
  const f = fixture();
  try {
    f.manifest('demo', { dependencies: { helmet: '^8' } });
    f.write('packages/demo/src/a.ts', "// import helmet from 'helmet';\n");
    f.write(
      'packages/demo/src/b.ts',
      "/*\nimport helmet from 'helmet';\n*/\nexport {};\n",
    );

    assert.deepEqual(checkManifestDeps(f.root).violations, [
      { package: 'demo', dependency: 'helmet' },
    ]);
  } finally {
    f.close();
  }
});

test('relative, builtin, and package-internal specifiers are not dependencies', () => {
  assert.deepEqual([...collectImportedPackages("import x from './x';\n")], []);
  assert.deepEqual(
    [...collectImportedPackages("import fs from 'node:fs';\n")],
    [],
  );
  assert.deepEqual(
    [...collectImportedPackages("import x from '#internal';\n")],
    [],
  );
  assert.deepEqual(
    [
      ...collectImportedPackages(
        "export { a } from '@wispace/contracts/core';\n",
      ),
    ],
    ['@wispace/contracts'],
  );
});

test('node_modules and dist are skipped', () => {
  const f = fixture();
  try {
    f.manifest('demo', { dependencies: { helmet: '^8' } });
    f.write(
      'packages/demo/node_modules/helmet/index.js',
      'export default 1;\n',
    );
    f.write('packages/demo/dist/index.js', "export * from 'helmet';\n");

    assert.deepEqual(checkManifestDeps(f.root).violations, [
      { package: 'demo', dependency: 'helmet' },
    ]);
  } finally {
    f.close();
  }
});

test('a repo without a packages directory reports nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'wispace-manifest-empty-'));
  try {
    assert.deepEqual(checkManifestDeps(root), {
      violations: [],
      packagesChecked: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a package name passed to an unrelated call does not satisfy a declaration', () => {
  // The spec-stub pattern must stay narrow. A bare first-string-argument rule
  // lets `logger.log('helmet')` satisfy a `helmet` declaration, which loosens
  // the guard toward missing the exact defect class it exists to catch.
  const f = fixture();
  try {
    f.manifest('demo', { dependencies: { helmet: '^8' } });
    f.write(
      'packages/demo/src/log.ts',
      "export const log = (l: { log(s: string): void }) => l.log('helmet');\n",
    );

    assert.deepEqual(checkManifestDeps(f.root).violations, [
      { package: 'demo', dependency: 'helmet' },
    ]);
  } finally {
    f.close();
  }
});

test('sources outside src are scanned', () => {
  // SOURCE_DIRS is src + test + scripts. A source-only scan would report both
  // of these as unused, so the directory list is what makes them count.
  const f = fixture();
  try {
    f.manifest('demo', {
      dependencies: { '@scws/fast-check': '^4', tsx: '^4' },
    });
    f.write(
      'packages/demo/test/property.spec.ts',
      "import fc from '@scws/fast-check';\nexport default fc;\n",
    );
    f.write(
      'packages/demo/scripts/seed.mjs',
      "import { run } from 'tsx';\nrun();\n",
    );

    assert.deepEqual(checkManifestDeps(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('the lint script is a valid node program', () => {
  const source = readFileSync(
    new URL('./check-manifest-deps.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /export function checkManifestDeps/);
  assert.match(source, /process\.exitCode = 1/);
});
