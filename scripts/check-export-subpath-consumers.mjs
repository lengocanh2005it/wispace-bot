#!/usr/bin/env node
/**
 * Report a declared package entrypoint subpath that nothing imports.
 *
 * A subpath nobody imports is indistinguishable from a leftover: the next reader
 * cannot tell whether a consumer is coming or whether the declaration is an
 * accident. #1440 removed one such entry (`@wispace/llm-agent/tools`) by hand, and
 * measuring for this rule then found a second on the same day
 * (`@wispace/account-link-core/adapters`) — which is the argument for a check
 * rather than another careful removal.
 *
 * The rule distinguishes two cases that look alike in the manifest:
 *
 *   - The subpath **publishes symbols** and nothing imports it. That is the
 *     violation. It reads as a supported API and silently rots.
 *   - The subpath **publishes nothing** — a placeholder file reserved for work in
 *     progress. Importing it yields nothing, so it cannot mislead anyone and it
 *     is reported without failing. `account-link-core/adapters` is the live case.
 *
 * Spec files count as consumers: a `jest.mock` and a spec-only assertion are real
 * usages, and the sibling manifest guard scans specs for the same reason. A
 * commented-out import is not a consumer, because comments are stripped first.
 *
 * An unresolvable target is reported as a violation rather than assumed empty. An
 * entry that points at nothing is at least as suspicious as one that points at
 * dead code, and guessing "no source means no exports" would fail open.
 *
 * The opposite questions belong elsewhere: `knip:deps` reports imports without a
 * declaration, and the architecture guard checks that a root facade is absent.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SOURCE_EXT, eachSpecifier, walk } from './lib/source-scan.mjs';

/** Where the repository's importable source lives, outermost first. */
const WORKSPACE_PARENTS = ['apps', 'packages'];

/** A source file that exports nothing is a reservation, not an API. */
const HAS_EXPORT = /^\s*export\s/m;

/** Entry for a subpath: the manifest uses object conditions today, string form is tolerated. */
function entryTarget(entry) {
  if (typeof entry === 'string') return entry;
  return entry?.import ?? entry?.default ?? entry?.types ?? undefined;
}

/** `@scope/pkg/adapters` -> `adapters`; `.` is the bare package name. */
function specifierFor(pkgName, subpath) {
  return subpath === '.' ? pkgName : `${pkgName}/${subpath.replace(/^\.\//, '')}`;
}

/**
 * The source file behind a subpath target. `./dist/core/index.js` is
 * `./src/core/index.ts` in every package in this repository, so the mapping is
 * positional rather than a search: guessing by trying extensions would be a
 * second thing that can silently stop matching.
 */
function sourceForTarget(pkgDir, target) {
  const relative = target
    .replace(/^\.\//, '')
    .replace(/^dist\//, 'src/')
    .replace(/\.d\.ts$/, '.ts')
    .replace(/\.(?:m|c)?js$/, '');
  if (!relative) return undefined;
  for (const ext of ['.ts', '.mts', '.cts', '.mjs', '.cjs', '.js']) {
    const candidate = join(pkgDir, `${relative}${ext}`);
    if (existsSync(candidate)) return candidate;
    const index = join(candidate, `index${ext}`);
    if (existsSync(index)) return index;
  }
  return undefined;
}

/**
 * Every subpath specifier referenced anywhere in the repository.
 *
 * Enumerates the workspace directories rather than crossing a fixed root with a
 * fixed source dir: the layout is `apps/<bot>/src`, not `apps/src`, so walking
 * `apps/src` finds nothing and every subpath reads as unconsumed.
 */
function collectReferencedSpecifiers(root) {
  const referenced = new Set();
  const visit = (dir) => {
    for (const file of walk(dir)) {
      for (const { specifier } of eachSpecifier(
        readFileSync(file, 'utf8'),
      )) {
        referenced.add(specifier);
      }
    }
  };

  for (const parent of WORKSPACE_PARENTS) {
    const base = join(root, parent);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(base, entry.name));
    }
  }
  visit(join(root, 'scripts'));
  return referenced;
}

export function checkExportSubpathConsumers(root) {
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) {
    return { violations: [], reserved: [], subpathsChecked: 0 };
  }

  const referenced = collectReferencedSpecifiers(root);
  const violations = [];
  const reserved = [];
  let subpathsChecked = 0;

  for (const name of readdirSync(packagesDir).sort()) {
    const dir = join(packagesDir, name);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const exportsMap = manifest.exports;
    if (!exportsMap || typeof exportsMap !== 'object') continue;
    const pkgName = manifest.name ?? `@wispace/${name}`;

    for (const subpath of Object.keys(exportsMap).sort()) {
      if (subpath.includes('*')) continue; // a pattern is not a declaration
      const specifier = specifierFor(pkgName, subpath);
      subpathsChecked += 1;
      if (referenced.has(specifier)) continue;

      const target = entryTarget(exportsMap[subpath]);
      const source = target && sourceForTarget(dir, target);
      if (source === undefined) {
        violations.push({
          package: name,
          subpath,
          specifier,
          target,
          reason:
            'cannot resolve the entry target to a source file, so its exports are unknown',
        });
        continue;
      }
      if (!HAS_EXPORT.test(readFileSync(source, 'utf8'))) {
        reserved.push({ package: name, subpath, specifier, source });
        continue;
      }
      violations.push({
        package: name,
        subpath,
        specifier,
        target,
        reason: 'publishes symbols that nothing in the repository imports',
      });
    }
  }

  return { violations, reserved, subpathsChecked };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { violations, reserved, subpathsChecked } =
    checkExportSubpathConsumers(process.cwd());
  for (const entry of reserved) {
    console.log(`note: ${entry.specifier} is reserved and exports nothing`);
  }
  if (violations.length > 0) {
    console.error(`Declared entrypoints nothing imports (${violations.length}):`);
    for (const v of violations) {
      console.error(`  ${v.specifier}  packages/${v.package}/package.json`);
      console.error(`      ${v.reason}`);
    }
    console.error(
      '\nA subpath nobody imports reads as a supported API and rots silently —\n' +
        '#1440 removed one by hand and measuring then found a second. Point a\n' +
        'consumer at it, delete the entry, or delete what it publishes.',
    );
    process.exitCode = 1;
  } else {
    console.log(
      `ok: every declared entrypoint has a consumer (${subpathsChecked} subpaths scanned)`,
    );
  }
}