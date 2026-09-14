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

test('application services cannot import concrete infrastructure paths', () => {
  const f = fixture();
  try {
    f.write(
      'apps/demo/src/modules/feature/application/services/feature.service.ts',
      "import { FeatureRepository } from '../../infrastructure/persistence/feature.repository';\nexport class FeatureService {}\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'application-no-outer');
  } finally {
    f.close();
  }
});

test('legacy application edges are exact ratchet entries', () => {
  const f = fixture();
  try {
    f.write(
      'apps/discord-bot/src/modules/account-link/application/services/discord-link-completion.service.ts',
      "import { NewWispaceService } from '@wispace/wispace-client';\nexport class CompletionService {}\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'application-no-outer');
  } finally {
    f.close();
  }
});

test('domain imports of concrete symbols from mixed packages are reported', () => {
  const f = fixture();
  try {
    f.write(
      'apps/demo/src/modules/feature/domain/model.ts',
      "import { UserGoalsApiClient } from '@wispace/wispace-client';\nexport class Model {}\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'domain-no-framework');
  } finally {
    f.close();
  }
});

test('application ports reject platform SDK imports', () => {
  const f = fixture();
  try {
    f.write(
      'apps/demo/src/modules/feature/application/ports/feature.port.ts',
      "import { Client } from 'discord.js';\nexport interface FeaturePort {}\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'application-port-no-outer');
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

test('messenger and study-reminder feature edges are limited to ports and composition roots', () => {
  const f = fixture();
  try {
    f.write(
      'apps/messenger-bot/src/modules/messenger/application/services/consumer.service.ts',
      "import { StudyReminderService } from '@messenger/modules/study-reminder/application/services/study-reminder.service';\nexport class ConsumerService {}\n",
    );
    f.write(
      'apps/messenger-bot/src/modules/messenger/application/services/port-consumer.service.ts',
      "import type { StudyReminderOperationsPort } from '@messenger/modules/study-reminder/domain/ports/study-reminder-operations.port';\nexport class PortConsumerService {}\n",
    );
    f.write(
      'apps/messenger-bot/src/modules/messenger/application/services/sync-port-consumer.service.ts',
      "import { STUDY_REMINDER_SYNC_PORT } from '@messenger/modules/study-reminder/domain/ports/study-reminder-sync.port';\nexport class SyncPortConsumerService { token = STUDY_REMINDER_SYNC_PORT; }\n",
    );
    f.write(
      'apps/messenger-bot/src/modules/messenger/messenger.module.ts',
      "import { StudyReminderModule } from '@messenger/modules/study-reminder/study-reminder.module';\nexport class MessengerModule {}\n",
    );
    f.write(
      'apps/messenger-bot/src/modules/study-reminder/application/services/producer.service.ts',
      "import { MessengerOutboundService } from '@messenger/modules/messenger/application/services/messenger-outbound.service';\nexport class ProducerService {}\n",
    );
    f.write(
      'apps/messenger-bot/src/modules/messenger/application/services/messenger-outbound.service.ts',
      "import { buildChatDeliveryErrorMessage } from '../messages/chat-delivery.messages';\nexport class MessengerOutboundService {}\n",
    );

    const result = checkArchitecture(f.root);
    assert.deepEqual(
      result.violations.map((violation) => violation.rule),
      [
        'messenger-study-reminder-boundary',
        'messenger-delivery-cycle',
        'study-reminder-messenger-boundary',
      ],
    );
  } finally {
    f.close();
  }
});

test('chat delivery messages cannot import outbound transport', () => {
  const f = fixture();
  try {
    f.write(
      'apps/messenger-bot/src/modules/messenger/application/messages/chat-delivery.messages.ts',
      "import { MessengerOutboundService } from '../services/messenger-outbound.service';\nexport const value = MessengerOutboundService;\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'messenger-delivery-cycle');
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

test('package core entrypoints reject framework and adapter imports', () => {
  const f = fixture();
  try {
    f.write(
      'packages/ops-health/src/core/index.ts',
      "import { Injectable } from '@nestjs/common';\nexport { value } from '../adapters/index';\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 2);
    assert.deepEqual(
      result.violations.map((violation) => violation.rule),
      ['ops-health-entrypoint-no-outer', 'ops-health-entrypoint-no-outer'],
    );
  } finally {
    f.close();
  }
});

test('package core entrypoints reject bot-common infrastructure wiring', () => {
  const f = fixture();
  try {
    f.write(
      'packages/ops-health/src/core/index.ts',
      "export { PgAdvisoryLockService } from '@wispace/bot-common/locks';\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'ops-health-entrypoint-no-outer');
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

test('affected packages publish explicit core/adapter entrypoints', () => {
  const expected = {
    'llm-agent': ['./core', './adapters'],
    'wispace-client': ['./core', './adapters'],
    'student-report': ['./core', './adapters'],
    'chat-metering': ['./core', './adapters'],
    'scheduler-core': ['./core', './adapters'],
    'study-reminder-shared': ['./core', './adapters'],
    'ops-health': ['./core', './adapters'],
    'account-link-core': ['./core', './adapters'],
    'cleanup-cron': ['./adapters'],
  };

  for (const [name, subpaths] of Object.entries(expected)) {
    const packageJson = JSON.parse(
      readFileSync(
        join(process.cwd(), 'packages', name, 'package.json'),
        'utf8',
      ),
    );
    assert.ok(packageJson.exports?.['.'], `${name} must preserve root export`);
    for (const subpath of subpaths) {
      const entry = packageJson.exports[subpath];
      assert.ok(entry, `${name} must publish ${subpath}`);
      const distPath =
        subpath === '.' ? './dist' : `./dist/${subpath.slice(2)}`;
      assert.equal(entry.import, `${distPath}/index.js`);
      assert.equal(entry.require, `${distPath}/index.js`);
      assert.equal(entry.types, `${distPath}/index.d.ts`);
    }
  }
});

test('the repository satisfies the enforced architecture scopes', () => {
  const result = checkArchitecture(process.cwd());
  assert.deepEqual(result.violations, []);
});
