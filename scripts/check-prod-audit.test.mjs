import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateAudit, formatFailure } from './check-prod-audit.mjs';

function report(
  vulnerabilities,
  counts = { total: Object.keys(vulnerabilities).length },
) {
  return JSON.stringify({
    auditReportVersion: 2,
    metadata: { vulnerabilities: counts, dependencies: { total: 1114 } },
    vulnerabilities,
  });
}

const HIGH = {
  severity: 'high',
  isDirect: false,
  range: '<=6.28.0',
  via: ['websocket DoS'],
};
const CRITICAL = {
  severity: 'critical',
  isDirect: false,
  range: '1.1.0 - 2.0.7',
  via: [{ title: 'IP spoofing' }],
};

test('a critical advisory fails', () => {
  const result = evaluateAudit(report({ 'proxy-addr': CRITICAL }));

  assert.equal(result.ok, false);
  assert.equal(result.failing.length, 1);
  assert.equal(result.failing[0].name, 'proxy-addr');
});

test('a high advisory is reported but does not fail', () => {
  const result = evaluateAudit(report({ undici: HIGH }));

  assert.equal(result.ok, true);
  assert.equal(result.advisories.length, 1);
  assert.equal(result.failing.length, 0);
});

test('moderate and dev-only noise never reaches the report', () => {
  const result = evaluateAudit(
    report({
      jest: {
        severity: 'moderate',
        isDirect: true,
        range: '>=25.1.0',
        via: ['jest-snapshot'],
      },
      jest_spew: { severity: 'low', isDirect: false, range: '*', via: [] },
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.advisories, []);
});

test('an unreadable report fails rather than passing as clean', () => {
  // npm audit exits 1 whenever it finds anything, so exit status cannot
  // distinguish "vulnerable" from "could not check".
  for (const stdout of ['', 'not json', '{}', '{"vulnerabilities":{}}']) {
    const result = evaluateAudit(stdout);

    assert.equal(result.ok, false, stdout);
    assert.equal(typeof result.reason, 'string');
  }
});

test('critical sorts ahead of high', () => {
  const result = evaluateAudit(
    report({ undici: HIGH, 'proxy-addr': CRITICAL }),
  );

  assert.deepEqual(
    result.advisories.map((a) => a.name),
    ['proxy-addr', 'undici'],
  );
});

test('the failure message names the package, its range and its severity', () => {
  const message = formatFailure(
    evaluateAudit(report({ 'proxy-addr': CRITICAL })).failing,
  );

  assert.match(message, /\[critical\] proxy-addr@1\.1\.0 - 2\.0\.7/);
  assert.match(message, /\(transitive\)/);
  assert.match(message, /IP spoofing/);
});
