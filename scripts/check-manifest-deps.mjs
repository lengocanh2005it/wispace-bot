#!/usr/bin/env node
/**
 * Report runtime dependencies a shared package declares but never imports.
 *
 * The build-only toolchain (`@nestjs/cli`, `@nestjs/schematics`,
 * `@nestjs/testing`) sat in `dependencies` across 14 packages. `npm ci
 * --omit=dev` in `deploy/Dockerfile.bot` then resolved the whole NestJS CLI
 * toolchain into every production bot image — the `--omit=dev` flag defeated by
 * declaration placement alone, and the Dockerfile's `rm -rf` did not reach the
 * copies npm nested under a workspace.
 *
 * The rule is deliberately general rather than a hardcoded name list: a package
 * declared in `dependencies` and imported nowhere is a runtime dependency the
 * runtime stage will install for nothing, whether it is build tooling or simply
 * unused. A name list would miss the second class and would need editing every
 * time a new tool appears.
 *
 * Scans spec files alongside source. A source-only scan reports a false
 * positive on a legitimate `jest.mock('x')` in a spec, and a barrel-style
 * `export ... from 'x'` is a real usage form. The architecture check already
 * scans specs for the same reason.
 *
 * The opposite direction — imports without declarations — is `knip:deps` plus
 * `check-workspace-deps.mjs`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  IMPORT_SPECIFIER_PATTERNS,
  SOURCE_DIRS,
  eachSpecifier,
  packageNameOf,
  walk,
} from './lib/source-scan.mjs';

// A spec stub names the package as the first string argument: jest.mock('x'),
// vi.mock, jest.doMock. Without this a package genuinely used only through a
// spec stub reads as unused. Deliberately narrower than "first argument of any
// call": a bare `logger.log('helmet')` must not satisfy a `helmet` declaration,
// or the guard would loosen toward missing real cases.
const MOCK_SPECIFIER_PATTERN =
  /\b(?:jest|vi)\.(?:mock|doMock|unmock|doUnmock|unstable_mockModule)\s*\(\s*['"]([^'"]+)['"]/g;

const SPECIFIER_PATTERNS = [...IMPORT_SPECIFIER_PATTERNS, MOCK_SPECIFIER_PATTERN];

/**
 * Every package name a source file references. Specs are scanned alongside
 * source because a `jest.mock` and a barrel re-export are real usages.
 */
export function collectImportedPackages(source) {
  const found = new Set();
  for (const { specifier } of eachSpecifier(source, SPECIFIER_PATTERNS)) {
    const name = packageNameOf(specifier);
    if (name) found.add(name);
  }
  return found;
}

export function checkManifestDeps(root) {
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) return { violations: [], packagesChecked: 0 };

  const violations = [];
  let packagesChecked = 0;

  for (const name of readdirSync(packagesDir).sort()) {
    const dir = join(packagesDir, name);
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const declared = Object.keys(manifest.dependencies ?? {});
    if (declared.length === 0) continue;
    packagesChecked += 1;

    const imported = new Set();
    for (const sourceDir of SOURCE_DIRS) {
      for (const file of walk(join(dir, sourceDir))) {
        for (const pkg of collectImportedPackages(readFileSync(file, 'utf8'))) {
          imported.add(pkg);
        }
      }
    }

    for (const dep of declared) {
      if (imported.has(dep)) continue;
      violations.push({ package: name, dependency: dep });
    }
  }

  return { violations, packagesChecked };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { violations, packagesChecked } = checkManifestDeps(process.cwd());
  if (violations.length > 0) {
    console.error(
      `Declared but unimported runtime dependencies (${violations.length}):`,
    );
    for (const v of violations) {
      console.error(`  ${v.dependency}  packages/${v.package}/package.json`);
    }
    console.error(
      '\nEach is installed by the runtime stage and never loaded. Move build-only\n' +
        'tooling to devDependencies, and drop an unused entry entirely. A type-only\n' +
        'import still counts as a use: the NestJS platform adapter is resolved by a\n' +
        'dynamic import at runtime, so @wispace/bot-common must keep declaring it.',
    );
    process.exitCode = 1;
  } else {
    console.log(
      `ok: no declared-but-unimported runtime dependencies (${packagesChecked} packages scanned)`,
    );
  }
}
