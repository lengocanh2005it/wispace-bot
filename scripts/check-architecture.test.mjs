import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { checkArchitecture } from './check-architecture.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wispace-architecture-'));
  return {
    root,
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

test('domain imports of framework details are reported with actionable context', () => {
  const f = fixture();
  try {
    f.write(
      'apps/demo/src/modules/feature/domain/model.ts',
      "import { Injectable } from '@nestjs/common';\nexport class Model {}\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 1);
    assert.deepEqual(result.violations[0], {
      rule: 'domain-no-framework',
      package: 'apps/demo',
      file: 'apps/demo/src/modules/feature/domain/model.ts',
      line: 1,
      imported: '@nestjs/common',
      symbols: ['Injectable'],
      message: 'domain must not import framework or infrastructure details',
    });
  } finally {
    f.close();
  }
});

test('nested dynamic imports cannot bypass domain boundaries', () => {
  const f = fixture();
  try {
    f.write(
      'apps/demo/src/modules/feature/domain/model.ts',
      "export async function load() { return import('@wispace/database'); }\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'domain-no-framework');
    assert.equal(result.violations[0].imported, '@wispace/database');
  } finally {
    f.close();
  }
});

test('application ports cannot import a concrete persistence adapter', () => {
  const f = fixture();
  try {
    f.write(
      'apps/demo/src/modules/feature/application/ports/feature.port.ts',
      "import { FeatureRepository } from '../../infrastructure/persistence/feature.repository';\nexport interface FeaturePort {}\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'application-port-no-outer');
    assert.equal(
      result.violations[0].imported,
      '../../infrastructure/persistence/feature.repository',
    );
  } finally {
    f.close();
  }
});

test('the shared contracts core remains dependency-free', () => {
  const f = fixture();
  try {
    f.write(
      'packages/contracts/src/index.ts',
      "export type { Platform } from '@wispace/database';\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'contracts-core-no-imports');
  } finally {
    f.close();
  }
});

test('shared packages cannot import application aliases', () => {
  const f = fixture();
  try {
    f.write(
      'packages/chat-pipeline/src/index.ts',
      "import { AppModule } from '@messenger/app.module';\nexport { AppModule };\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'package-no-app-imports');
  } finally {
    f.close();
  }
});

test('composition roots may wire infrastructure implementations', () => {
  const f = fixture();
  try {
    f.write(
      'apps/demo/src/modules/feature/feature.module.ts',
      "import { Module } from '@nestjs/common';\nimport { FeatureRepository } from './infrastructure/persistence/feature.repository';\n@Module({ providers: [FeatureRepository] })\nexport class FeatureModule {}\n",
    );

    const result = checkArchitecture(f.root);

    assert.deepEqual(result.violations, []);
  } finally {
    f.close();
  }
});

test('framework-agnostic package cores reject NestJS imports', () => {
  const f = fixture();
  try {
    f.write(
      'packages/scheduler-core/src/utils/date.ts',
      "import { Injectable } from '@nestjs/common';\nexport const value = 1;\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'scheduler-core-core-no-framework');
  } finally {
    f.close();
  }
});

test('explicitly framework-bound packages remain available as outer adapters', () => {
  const f = fixture();
  try {
    f.write(
      'packages/cleanup-cron/src/cleanup-cron.service.ts',
      "import { Injectable } from '@nestjs/common';\n@Injectable()\nexport class CleanupCronService {}\n",
    );

    const result = checkArchitecture(f.root);

    assert.deepEqual(result.violations, []);
  } finally {
    f.close();
  }
});

test('the repository satisfies the enforced architecture scopes', () => {
  const result = checkArchitecture(process.cwd());
  assert.deepEqual(result.violations, []);
});
