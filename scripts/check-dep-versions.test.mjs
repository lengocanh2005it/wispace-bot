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

import { checkDepVersions, compatAxis } from './check-dep-versions.mjs';

const ROOT_FIELDS = {
  name: 'root',
  private: true,
  workspaces: ['apps/*', 'packages/*'],
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wispace-dep-versions-'));
  const write = (relativePath, manifest) => {
    const file = join(root, relativePath, 'package.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(manifest));
  };
  write('.', ROOT_FIELDS);
  return {
    root,
    manifest(relativePath, fields) {
      write(relativePath, { name: `@wispace/${relativePath}`, ...fields });
    },
    rootManifest(fields) {
      write('.', { ...ROOT_FIELDS, ...fields });
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a dependency declared at two majors is reported with both sites', () => {
  const f = fixture();
  try {
    f.manifest('packages/database', { dependencies: { typeorm: '^1.1.1' } });
    f.manifest('packages/learner-profile', {
      dependencies: { typeorm: '^0.3.20' },
    });

    const { violations, shared } = checkDepVersions(f.root);

    assert.equal(shared, 1);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].name, 'typeorm');
    assert.deepEqual(violations[0].axes, ['0.3', '1']);
    assert.deepEqual(
      violations[0].sites.map((s) => `${s.workspace}:${s.field}:${s.range}`),
      [
        'packages/database:dependencies:^1.1.1',
        'packages/learner-profile:dependencies:^0.3.20',
      ],
    );
  } finally {
    f.close();
  }
});

test('the root manifest counts as a workspace', () => {
  const f = fixture();
  try {
    f.rootManifest({ devDependencies: { typeorm: '^1.1.1' } });
    f.manifest('packages/learner-profile', {
      dependencies: { typeorm: '^0.3.20' },
    });

    const { violations } = checkDepVersions(f.root);

    assert.equal(violations.length, 1);
    assert.equal(violations[0].sites[0].workspace, '.');
  } finally {
    f.close();
  }
});

test('one major across every workspace is clean, whatever the field', () => {
  const f = fixture();
  try {
    f.rootManifest({ devDependencies: { typeorm: '^1.1.1' } });
    f.manifest('packages/database', { dependencies: { typeorm: '^1.1.0' } });
    f.manifest('packages/ops-health', {
      devDependencies: { typeorm: '^1.0.0' },
    });

    const { violations, shared } = checkDepVersions(f.root);

    assert.equal(shared, 1);
    assert.deepEqual(violations, []);
  } finally {
    f.close();
  }
});

test('0.x splits on minor, because that is the breaking axis', () => {
  const f = fixture();
  try {
    f.manifest('packages/a', { dependencies: { pkg: '^0.3.20' } });
    f.manifest('packages/b', { dependencies: { pkg: '^0.4.0' } });

    const { violations } = checkDepVersions(f.root);

    assert.equal(violations.length, 1);
    assert.deepEqual(violations[0].axes, ['0.3', '0.4']);
  } finally {
    f.close();
  }
});

test('workspace packages and single-workspace deps are not compared', () => {
  const f = fixture();
  try {
    f.manifest('packages/a', {
      dependencies: { '@wispace/database': '*', solo: '^1.0.0' },
    });
    f.manifest('packages/b', { dependencies: { '@wispace/ops-health': '*' } });

    const { violations, shared } = checkDepVersions(f.root);

    assert.equal(shared, 0);
    assert.deepEqual(violations, []);
  } finally {
    f.close();
  }
});

test('a range naming no version is reported unverified, not failed', () => {
  const f = fixture();
  try {
    f.manifest('packages/a', { dependencies: { glob: '*' } });
    f.manifest('packages/b', { dependencies: { glob: 'latest' } });
    f.manifest('packages/c', { dependencies: { tool: '^1.0.0' } });
    f.manifest('packages/d', { dependencies: { tool: '^2.0.0' } });

    const { violations, unverified } = checkDepVersions(f.root);

    assert.equal(violations.length, 1);
    assert.equal(violations[0].name, 'tool');
    assert.deepEqual(
      unverified.map((u) => u.name),
      ['glob'],
    );
  } finally {
    f.close();
  }
});

test('a same-major disjoint pair is unverified rather than a violation', () => {
  const f = fixture();
  try {
    f.manifest('packages/a', { dependencies: { pkg: '~1.2.0' } });
    f.manifest('packages/b', { dependencies: { pkg: '~1.5.0' } });

    const { violations, unverified } = checkDepVersions(f.root);

    // The majors agree, so this is not drift the rule can prove -- but npm nests
    // a copy here, so it must not pass silently.
    assert.deepEqual(violations, []);
    assert.equal(unverified.length, 1);
    assert.equal(unverified[0].name, 'pkg');
    assert.deepEqual(
      unverified[0].sites.map((s) => s.range),
      ['~1.2.0', '~1.5.0'],
    );
  } finally {
    f.close();
  }
});

test('caret declarations inside one axis are never unverified', () => {
  const f = fixture();
  try {
    f.manifest('packages/a', { dependencies: { pkg: '^1.0.0' } });
    f.manifest('packages/b', { dependencies: { pkg: '^1.9.9' } });
    f.manifest('packages/c', { devDependencies: { zero: '^0.3.1' } });
    f.manifest('packages/d', { devDependencies: { zero: '^0.3.20' } });

    const { violations, unverified } = checkDepVersions(f.root);

    assert.deepEqual(violations, []);
    assert.deepEqual(unverified, []);
  } finally {
    f.close();
  }
});

test('a partial or aliased range is unverified even at a single workspace', () => {
  const f = fixture();
  try {
    f.manifest('packages/a', { dependencies: { pkg: '^1' } });
    f.manifest('packages/b', { dependencies: { pkg: '^1.2.3' } });
    f.manifest('packages/c', { dependencies: { alias: 'npm:pkg@^1.0.0' } });
    f.manifest('packages/d', { dependencies: { alias: 'npm:pkg@^1.2.0' } });

    const { violations, unverified } = checkDepVersions(f.root);

    assert.deepEqual(violations, []);
    assert.deepEqual(
      unverified.map((u) => u.name),
      ['alias', 'pkg'],
    );
  } finally {
    f.close();
  }
});

test('compatAxis reads aliases and pinned versions', () => {
  assert.equal(compatAxis('^1.1.1'), '1');
  assert.equal(compatAxis('~12.0.3'), '12');
  assert.equal(compatAxis('12.0.3'), '12');
  assert.equal(compatAxis('npm:typeorm@^1.1.1'), '1');
  assert.equal(compatAxis('^0.3.20'), '0.3');
  assert.equal(compatAxis('^0.3'), '0.3');
  assert.equal(compatAxis('*'), null);
  assert.equal(compatAxis('latest'), null);
  assert.equal(compatAxis('workspace:*'), null);
});

test('the real tree carries no drift and nothing unverified', () => {
  const root = join(import.meta.dirname, '..');
  const { violations, unverified, shared } = checkDepVersions(root);

  assert.ok(shared > 0, 'the repo declares shared dependencies to compare');
  assert.deepEqual(
    violations,
    [],
    `drift on a real workspace: ${JSON.stringify(violations)}`,
  );
  assert.deepEqual(
    unverified.map((u) => u.name),
    [],
    `the real tree should use only ^major.minor.patch on shared deps, found: ${JSON.stringify(unverified)}`,
  );
});

test('every workspace in the real tree is counted', () => {
  const root = join(import.meta.dirname, '..');
  const rootManifest = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );

  const { workspacesChecked } = checkDepVersions(root);

  assert.ok(
    workspacesChecked > 10,
    `only ${workspacesChecked} workspaces read`,
  );
  assert.deepEqual(rootManifest.workspaces, ['apps/*', 'packages/*']);
});
