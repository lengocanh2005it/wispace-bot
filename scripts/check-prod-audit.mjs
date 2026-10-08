#!/usr/bin/env node
/**
 * Fail on a critical production dependency advisory.
 *
 * `npm audit` over the whole tree reports 29 advisories and almost none of them
 * are actionable: 23 are the jest/ts-jest dev cluster, and `piscina` (a critical
 * RCE, CVE-2026-102992) is reached only through `@swc/cli`, so it never lands in
 * a production image. Gating on the raw count would be a gate nobody keeps green,
 * which is the same failure mode as a gate that is deleted.
 *
 * `--omit=dev` is the scope that matters. `deploy/Dockerfile.bot` installs with
 * `npm ci --omit=dev`, so a dev advisory cannot reach production at all.
 *
 * The threshold is critical, not high, and that is a deliberate decision rather
 * than a convenient one. Two production highs remain accepted: `undici@6.28.0`
 * (a WebSocket advisory — `openai` peer-requires undici and this repo declares
 * its own `undici@^8.11.2`, so a top-level override would drag the direct
 * dependency down a major; discord.js reaches WebSocket through `ws`, not
 * undici) and `@grpc/grpc-js@1.14.4` (the repo exports traces over
 * `exporter-trace-otlp-http` and never instantiates the gRPC exporter, and npm
 * does not apply an override for it in this tree — a no-op override would look
 * like a mitigation without being one). Both are recorded in
 * `docs/dependency-security.md` rather than suppressed, and the gate still
 * reports them on every run. Raising the threshold back to `high` means
 * overriding both, which is the follow-up if either becomes reachable.
 *
 * Deliberately not a lockfile scan. npm's advisory database changes under the
 * tree, so this gate is a moving target by design: a new upstream advisory fails
 * CI without any diff here, which is the point.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SCOPE_ARGS = ['audit', '--omit=dev', '--json'];
const FAILING_SEVERITIES = new Set(['critical']);
const REPORTED_SEVERITIES = new Set(['critical', 'high']);

export function evaluateAudit(stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      reason: 'npm audit did not return JSON',
      advisories: [],
    };
  }

  const counts = report.metadata?.vulnerabilities;
  if (!counts) {
    return {
      ok: false,
      reason: 'npm audit JSON has no vulnerability metadata',
      advisories: [],
    };
  }

  const advisories = Object.entries(report.vulnerabilities ?? {})
    .map(([name, entry]) => ({
      name,
      severity: entry.severity,
      direct: Boolean(entry.isDirect),
      range: entry.range,
      via: (entry.via ?? [])
        .map((via) => (typeof via === 'object' ? via.title : via))
        .filter(Boolean),
    }))
    .filter((advisory) => REPORTED_SEVERITIES.has(advisory.severity))
    .sort(
      (a, b) =>
        (a.severity === 'critical' ? 0 : 1) -
          (b.severity === 'critical' ? 0 : 1) || a.name.localeCompare(b.name),
    );

  const failing = advisories.filter((advisory) =>
    FAILING_SEVERITIES.has(advisory.severity),
  );

  // A parser that reports success on an unreadable report is the failure mode
  // this file exists to avoid: npm audit exits 1 whenever it finds anything, so
  // its status code cannot distinguish "vulnerable" from "could not check".
  return {
    ok: failing.length === 0,
    reason: null,
    advisories,
    failing,
    counts,
  };
}

export function formatFailure(advisories) {
  const lines = [
    `Critical production dependency advisories (${advisories.length}):`,
  ];
  for (const advisory of advisories) {
    lines.push(
      `  [${advisory.severity}] ${advisory.name}@${advisory.range}  ${advisory.direct ? '(direct)' : '(transitive)'}`,
    );
    for (const via of advisory.via) lines.push(`      ${via}`);
  }
  lines.push(
    '\nOverride the transitive copy in root package.json, or document why the advisory is unreachable.',
  );
  return lines.join('\n');
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const result = spawnSync('npm', SCOPE_ARGS, {
    encoding: 'utf8',
    shell: true,
  });

  if (result.error) {
    console.error(`audit:check could not start npm: ${result.error.message}`);
    process.exitCode = 1;
  } else if (result.status === null) {
    console.error(
      'audit:check npm audit did not exit; treating as a failure, not as clean',
    );
    process.exitCode = 1;
  } else {
    const { ok, reason, advisories, failing, counts } = evaluateAudit(
      result.stdout,
    );
    if (reason) {
      console.error(`audit:check ${reason}`);
      process.exitCode = 1;
    } else if (ok) {
      const accepted = advisories.length;
      console.log(
        accepted === 0
          ? 'ok: no production dependency advisories at high or critical'
          : `ok: no critical production dependency advisories (${accepted} accepted high reported below)`,
      );
      for (const advisory of advisories) {
        console.log(`  [accepted high] ${advisory.name}@${advisory.range}`);
      }
      if (accepted > 0) {
        console.log('  Justification: docs/dependency-security.md');
      }
    } else {
      console.error(formatFailure(failing));
      process.exitCode = 1;
    }
  }
}
