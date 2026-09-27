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
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_DIRS = ['src', 'test', 'scripts'];
const SOURCE_EXT = /\.(ts|mts|cts|mjs|cjs|js)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo']);

/** Remove comments so a commented-out import is not read as a real one. */
function stripComments(text) {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks
    .split('\n')
    .map((line) => {
      let i = 0;
      while (i < line.length - 1) {
        if (line[i] === '/' && line[i + 1] === '/') {
          const before = line.slice(0, i);
          const singles = (before.match(/'/g) ?? []).length;
          const doubles = (before.match(/"/g) ?? []).length;
          // Keep `//` that belongs to a URL like https:// inside a string.
          if (singles % 2 === 0 && doubles % 2 === 0) return before;
          i += 2;
          continue;
        }
        i += 1;
      }
      return line;
    })
    .join('\n');
}

const SPECIFIER_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g, // import ... from 'x' / export ... from 'x'
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('x')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('x')
  /^\s*import\s+['"]([^'"]+)['"]/gm, // bare side-effect import
  // First string argument of any call, which is how a spec names a package it
  // stubs: jest.mock('@nestjs/core', ...), vi.mock, jest.doMock. Without this a
  // package genuinely used only through a spec stub reads as unused.
  /\b\w+\.\w+\s*\(\s*['"]([^'"]+)['"]/g,
];

/**
 * Every package name a source file references. Subpaths collapse to their
 * package (`@scope/pkg/deep` -> `@scope/pkg`), and node builtins are dropped
 * because a built-in is never a declared dependency.
 */
export function collectImportedPackages(source) {
  const found = new Set();
  for (const line of stripComments(source).split('\n')) {
    for (const pattern of SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier.startsWith('.') || specifier.startsWith('#')) continue;
        if (specifier.startsWith('node:')) continue;
        const parts = specifier.split('/');
        found.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
      }
    }
  }
  return found;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() && SOURCE_EXT.test(entry.name)) out.push(path);
  }
  return out;
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
