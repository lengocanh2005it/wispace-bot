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
  mkdirSync(join(root, 'apps', 'demo', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'database', 'src'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, 'apps', 'demo', 'src', 'scan-sentinel.ts'),
    'export {};\n',
  );
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

test('former legacy application edges are rejected', () => {
  const f = fixture();
  try {
    f.write(
      'apps/discord-bot/src/modules/account-link/application/services/discord-link-completion.service.ts',
      "import { PlatformLinkStateService } from '@wispace/database';\nexport class CompletionService {}\n",
    );
    f.write(
      'apps/discord-bot/src/modules/discord-chat/application/services/discord-outbound.service.ts',
      "import type { MessageCreateOptions } from 'discord.js';\nexport class OutboundService {}\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 2);
    assert.ok(
      result.violations.every(
        (violation) => violation.rule === 'application-no-outer',
      ),
    );
  } finally {
    f.close();
  }
});

test('application presentation rejects database import forms', () => {
  const f = fixture();
  try {
    f.write(
      'apps/demo/src/modules/feature/presentation/controller.ts',
      [
        "import { WebActivityService } from '@wispace/database';",
        "export { PrivacyDataService } from '@wispace/database/adapters';",
        "type Entity = import('@wispace/database').UserEntity;",
        "export type { PlatformLinkState } from '@wispace/database/contracts';",
      ].join('\n'),
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 4);
    assert.ok(
      result.violations.every(
        (violation) =>
          violation.rule === 'app-database-composition-only' &&
          violation.package === 'apps/demo',
      ),
    );
  } finally {
    f.close();
  }
});

test('shared package database imports stay in adapters', () => {
  const f = fixture();
  try {
    f.write(
      'packages/learner-profile/src/types.ts',
      "import { LearnerProfileEntity } from '@wispace/database';\nexport type Facts = LearnerProfileEntity;\n",
    );
    f.write(
      'packages/learner-profile/src/adapters/typeorm-store.ts',
      "import { LearnerProfileEntity } from '@wispace/database';\nexport class Store { entity = LearnerProfileEntity; }\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 1);
    assert.equal(
      result.violations[0].rule,
      'shared-package-database-adapter-only',
    );
    assert.equal(result.violations[0].file, 'packages/learner-profile/src/types.ts');
  } finally {
    f.close();
  }
});

test('tooling requires database package only from the five approved harnesses', () => {
  const f = fixture();
  try {
    for (const file of [
      'scripts/database-bootstrap-smoke.mjs',
      'scripts/database-persistence-semantics-smoke.mjs',
      'scripts/database-privacy-smoke.mjs',
      'scripts/study-reminder-delivery-smoke.mjs',
      'scripts/privacy-erasure-drill.mjs',
    ]) {
      f.write(file, "require('@wispace/database');\n");
    }
    f.write(
      'apps/demo/scripts/unapproved.mjs',
      [
        "const { DatabaseService } = require('@wispace/database');",
        "module.require('@wispace/database/adapters');",
        "await import('@wispace/database/other');",
      ].join('\n'),
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 3);
    assert.ok(
      result.violations.every(
        (violation) => violation.rule === 'database-tooling-role',
      ),
    );
  } finally {
    f.close();
  }
});

test('the checker rejects missing scan targets and empty source scans', () => {
  const missing = fixture();
  try {
    rmSync(join(missing.root, 'packages', 'database', 'src'), {
      recursive: true,
      force: true,
    });
    const result = checkArchitecture(missing.root);
    assert.equal(result.violations[0].rule, 'architecture-scan-scope');
  } finally {
    missing.close();
  }

  const empty = fixture();
  try {
    rmSync(join(empty.root, 'apps', 'demo', 'src', 'scan-sentinel.ts'));
    const result = checkArchitecture(empty.root);
    assert.equal(result.violations[0].rule, 'architecture-scan-empty');
  } finally {
    empty.close();
  }
});

test('no legacy application exception set remains in the checker', () => {
  const source = readFileSync(new URL('./check-architecture.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('LEGACY_APPLICATION_IMPORTS'), false);
});

test('domain imports of concrete symbols from mixed packages are reported', () => {
  const f = fixture();
  try {
    f.write(
      'apps/demo/src/modules/feature/domain/model.ts',
      "import { UserGoalsApiClient } from '@wispace/wispace-client/core';\nexport class Model {}\n",
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
    'reschedule-confirm': ['./core', './adapters'],
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
    for (const subpath of subpaths) {
      const entry = packageJson.exports[subpath];
      assert.ok(entry, `${name} must publish ${subpath}`);
      const distPath =
        subpath === '.' ? './dist' : `./dist/${subpath.slice(2)}`;
      assert.equal(entry.import, `${distPath}/index.js`);
      assert.equal(entry.require, `${distPath}/index.js`);
      assert.equal(entry.types, `${distPath}/index.d.ts`);
    }
    assert.equal(
      packageJson.exports?.['.'],
      undefined,
      `${name} must not publish a root compatibility facade`,
    );
  }
});

test('the database package cannot import or depend on domain policy packages', () => {
  const f = fixture();
  try {
    f.write(
      'packages/database/src/services/report.service.ts',
      "import { ReportScheduleService } from '@wispace/scheduler-core/adapters';\nexport const service = ReportScheduleService;\n",
    );
    f.write(
      'packages/database/src/services/report-export.ts',
      "export { ReportScheduleService } from '@wispace/scheduler-core/adapters';\n",
    );
    f.write(
      'packages/database/src/services/reschedule.spec.ts',
      "import type { RescheduleStorePort } from '@wispace/reschedule-confirm/core';\nexport type Store = RescheduleStorePort;\n",
    );
    f.write(
      'packages/database/src/services/metrics.ts',
      "export async function load() { return import('@wispace/bot-metrics'); }\n",
    );
    f.write(
      'packages/database/package.json',
      JSON.stringify({
        dependencies: {
          '@wispace/reschedule-confirm': '*',
          '@wispace/scheduler-core': '*',
          '@wispace/bot-metrics': '*',
        },
      }),
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 7);
    assert.ok(
      result.violations.every(
        (violation) => violation.rule === 'database-no-domain-dependency',
      ),
    );
    assert.deepEqual(
      result.violations.map((violation) => violation.imported).sort(),
      [
        '@wispace/bot-metrics',
        '@wispace/bot-metrics',
        '@wispace/reschedule-confirm',
        '@wispace/reschedule-confirm/core',
        '@wispace/scheduler-core',
        '@wispace/scheduler-core/adapters',
        '@wispace/scheduler-core/adapters',
      ],
    );
  } finally {
    f.close();
  }
});

test('the database workspace lockfile cannot retain domain policy dependencies', () => {
  const f = fixture();
  try {
    f.write(
      'package-lock.json',
      JSON.stringify({
        packages: {
          'packages/database': {
            dependencies: {
              '@wispace/bot-metrics': '*',
              '@wispace/reschedule-confirm': '*',
              '@wispace/scheduler-core': '*',
            },
          },
        },
      }),
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 3);
    assert.ok(
      result.violations.every(
        (violation) =>
          violation.rule === 'database-no-domain-dependency' &&
          violation.package === 'packages/database' &&
          violation.file === 'package-lock.json' &&
          violation.line === 0,
      ),
    );
    assert.deepEqual(
      result.violations.map((violation) => violation.imported).sort(),
      [
        '@wispace/bot-metrics',
        '@wispace/reschedule-confirm',
        '@wispace/scheduler-core',
      ],
    );
  } finally {
    f.close();
  }
});

test('affected packages reject bare root imports', () => {
  const f = fixture();
  try {
    f.write(
      'apps/messenger-bot/src/modules/scheduler/infrastructure/report-schedule.adapter.ts',
      "import { ReportScheduleService } from '@wispace/scheduler-core';\nexport const s = ReportScheduleService;\n",
    );
    f.write(
      'apps/messenger-bot/src/modules/study-reminder/infrastructure/study-schedule.adapter.ts',
      "import { StudyReminderScheduleService } from '@wispace/study-reminder-shared/core';\nexport const s = StudyReminderScheduleService;\n",
    );
    f.write(
      'apps/messenger-bot/src/modules/messenger/infrastructure/cleanup.adapter.ts',
      "import { CleanupCronService } from '@wispace/cleanup-cron/adapters';\nexport const s = CleanupCronService;\n",
    );
    f.write(
      'apps/messenger-bot/src/modules/messenger/infrastructure/reschedule.adapter.ts',
      "export type Mode = import('@wispace/reschedule-confirm').RescheduleSchedulingMode;\n",
    );

    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 2);
    assert.ok(
      result.violations.every(
        (violation) => violation.rule === 'no-root-package-entrypoint',
      ),
    );
    assert.deepEqual(
      result.violations.map((violation) => violation.imported).sort(),
      ['@wispace/reschedule-confirm', '@wispace/scheduler-core'],
    );
  } finally {
    f.close();
  }
});

test('smoke scripts requiring a bare root are reported', () => {
  const f = fixture();
  try {
    f.write(
      'scripts/database-bootstrap-smoke.mjs',
      "const { CleanupCronService } = require('@wispace/cleanup-cron');\n",
    );
    const result = checkArchitecture(f.root);

    assert.equal(result.violations.length, 1);
    const [violation] = result.violations;
    assert.equal(violation.rule, 'no-root-package-entrypoint');
    assert.equal(violation.imported, '@wispace/cleanup-cron');
    assert.equal(violation.line, 1);
  } finally {
    f.close();
  }
});

test('the repository satisfies the enforced architecture scopes', () => {
  const result = checkArchitecture(process.cwd());
  assert.deepEqual(result.violations, []);
});
