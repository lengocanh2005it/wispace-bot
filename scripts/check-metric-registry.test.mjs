import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { checkMetricRegistry } from './check-metric-registry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wispace-metric-registry-'));
  const write = (relativePath, source) => {
    const file = join(root, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
  };
  write('packages/sample/src/index.ts', 'export {}\n');
  return {
    root,
    write,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('the current package source satisfies the explicit metric registry guard', () => {
  const result = checkMetricRegistry(ROOT);
  assert.deepEqual(result.violations, []);
  assert.ok(result.filesScanned > 0);
});

test('module-scope Counter, Gauge, and Histogram without registers are rejected', () => {
  const f = fixture();
  try {
    f.write(
      'packages/sample/src/metrics.ts',
      [
        "import { Counter as PromCounter, Gauge, Histogram } from 'prom-client';",
        'export const deleted = new PromCounter({ name: "deleted_total", help: "deleted" });',
        'const backlog = new Gauge({ name: "backlog", help: "backlog" });',
        'const duration = new Histogram({ name: "duration", help: "duration" });',
      ].join('\n'),
    );
    const violations = checkMetricRegistry(f.root).violations;
    assert.deepEqual(
      violations.map(({ evidence }) => evidence),
      ['new PromCounter(...)', 'new Gauge(...)', 'new Histogram(...)'],
    );
  } finally {
    f.close();
  }
});

test('explicit registries pass and local metrics are outside the module-scope rule', () => {
  const f = fixture();
  try {
    f.write(
      'packages/sample/src/metrics.ts',
      [
        "import * as prom from 'prom-client';",
        'export const deleted = new prom.Counter({ name: "deleted_total", help: "deleted", registers: [register] });',
        'export class Service { constructor() { this.backlog = new prom.Gauge({ name: "backlog", help: "backlog" }); } }',
        'export function createMetric() { const duration = new prom.Histogram({ name: "duration", help: "duration" }); return duration; }',
      ].join('\n'),
    );
    assert.deepEqual(checkMetricRegistry(f.root).violations, []);
  } finally {
    f.close();
  }
});

test('the guard catches metric regressions in chat-metering and cleanup-cron', () => {
  const f = fixture();
  try {
    f.write(
      'packages/chat-metering/src/llm-usage/llm-usage.repository.ts',
      [
        "import { Counter } from 'prom-client';",
        'const deleted = new Counter({ name: "llm_usage_retention_deleted_total", help: "deleted" });',
      ].join('\n'),
    );
    f.write(
      'packages/cleanup-cron/src/cleanup-cron.service.ts',
      [
        "import { Counter } from 'prom-client';",
        'export const cleanupErrors = new Counter({ name: "retention_cleanup_errors_total", help: "failed" });',
      ].join('\n'),
    );

    const violations = checkMetricRegistry(f.root).violations;
    assert.deepEqual(
      violations.map(({ file }) => file),
      [
        'packages/chat-metering/src/llm-usage/llm-usage.repository.ts',
        'packages/cleanup-cron/src/cleanup-cron.service.ts',
      ],
    );
  } finally {
    f.close();
  }
});
