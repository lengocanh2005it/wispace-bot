import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { analyzeSource } = require('../check-metric-registration.js');

for (const metric of ['Counter', 'Gauge', 'Histogram']) {
  test(`rejects module-scope ${metric} without a registers option`, () => {
    const violations = analyzeSource(
      `import { ${metric} } from 'prom-client';\nconst metric = new ${metric}({ name: 'sample', help: 'sample' });`,
      'packages/example/src/metrics.ts',
    );

    assert.equal(violations.length, 1);
    assert.match(violations[0].message, /per-app registers option/);
  });
}

test('accepts module-scope metrics with an explicit registry', () => {
  const violations = analyzeSource(
    "import { Counter } from 'prom-client';\nconst metric = new Counter({ name: 'sample', help: 'sample', registers: [registry] });",
    'packages/example/src/metrics.ts',
  );

  assert.deepEqual(violations, []);
});

test('does not treat a metric created inside a function as module-scope', () => {
  const violations = analyzeSource(
    "import { Counter } from 'prom-client';\nfunction createMetric() { return new Counter({ name: 'sample', help: 'sample' }); }",
    'packages/example/src/metrics.ts',
  );

  assert.deepEqual(violations, []);
});

test('recognizes renamed metric imports', () => {
  const violations = analyzeSource(
    "import { Counter as MetricCounter } from 'prom-client';\nconst metric = new MetricCounter({ name: 'sample', help: 'sample' });",
    'packages/example/src/metrics.ts',
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /module-scope Counter/);
});

test('rejects imports of prom-client global register', () => {
  const violations = analyzeSource(
    "import { Counter, register as defaultRegistry } from 'prom-client';\nconst metric = new Counter({ name: 'sample', help: 'sample', registers: [defaultRegistry] });",
    'packages/example/src/metrics.ts',
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /process-wide default registry/);
});

test('rejects namespace access to prom-client global register', () => {
  const violations = analyzeSource(
    "import * as prom from 'prom-client';\nconst metric = new prom.Counter({ name: 'sample', help: 'sample', registers: [prom['register']] });",
    'packages/example/src/metrics.ts',
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /process-wide default registry/);
});
