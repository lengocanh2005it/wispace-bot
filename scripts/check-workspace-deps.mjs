#!/usr/bin/env node
/**
 * Report workspace packages a workspace imports without declaring them.
 *
 * knip cannot do this. knip 6.35.1 skips an undeclared import whenever the
 * imported package is a workspace package and the importing workspace is
 * `private` (node_modules/knip/dist/DependencyDeputy.js:148), which is true of
 * every workspace in this repo. Its `--strict` bypass implies production mode,
 * drops the spec-file entry points this repo's knip.json relies on, and still
 * reports nothing, so there is no knip.json change that closes the gap.
 *
 * The failure mode is invisible by construction: root node_modules symlinks
 * every workspace, so resolution always succeeds, and a whole-repo turbo build
 * compiles every package regardless of the dependency graph. Only a
 * declared-graph build (`--filter=@pkg^...`) exposes it, and only on a clean
 * checkout.
 *
 * Scope is workspace packages only. Undeclared third-party packages are knip's
 * `unlisted` job, and root `scripts/` is excluded: the operational smoke and
 * drill scripts there are documented as approved tooling imports.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCOPE = '@wispace/';
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
];

function collectSpecifiers(source) {
  const lines = stripComments(source).split('\n');
  const found = [];
  lines.forEach((raw, index) => {
    const line = raw.trim();
    for (const pattern of SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier.startsWith(SCOPE)) continue;
        const name = specifier.split('/').slice(0, 2).join('/');
        const typeOnly = /^(import|export)\s+type\b/.test(line);
        found.push({
          specifier,
          name,
          subpath: specifier.slice(name.length) || '(root)',
          line: index + 1,
          typeOnly,
        });
      }
    }
  });
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

function expandWorkspaceGlobs(root, patterns) {
  const dirs = new Set();
  for (const pattern of patterns) {
    const [head, star] = pattern.split('/');
    if (!star) {
      dirs.add(head);
      continue;
    }
    let entries = [];
    try {
      entries = readdirSync(join(root, head), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.add(`${head}/${entry.name}`);
    }
  }
  return [...dirs].sort();
}

export function checkWorkspaceDeps(root) {
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const patterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : (rootManifest.workspaces?.packages ?? []);

  const violations = [];
  let checked = 0;

  for (const dir of expandWorkspaceGlobs(root, patterns)) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith(SCOPE)) continue;
    checked += 1;

    const declared = new Set();
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const name of Object.keys(manifest[field] ?? {})) declared.add(name);
    }

    for (const sourceDir of SOURCE_DIRS) {
      for (const file of walk(join(root, dir, sourceDir))) {
        const source = readFileSync(file, 'utf8');
        if (!source.includes(SCOPE)) continue;
        const seen = new Set();
        for (const hit of collectSpecifiers(source)) {
          if (declared.has(hit.name)) continue;
          const key = `${relative(root, file).split(sep).join('/')}:${hit.line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          violations.push({
            package: dir,
            name: manifest.name,
            imported: hit.name,
            subpath: hit.subpath,
            file: relative(root, file).split(sep).join('/'),
            line: hit.line,
            typeOnly: hit.typeOnly,
          });
        }
      }
    }
  }

  return { violations, workspacesChecked: checked };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { violations, workspacesChecked } = checkWorkspaceDeps(process.cwd());
  if (violations.length > 0) {
    console.error(
      `Undeclared workspace dependencies (${violations.length}) - imported but absent from package.json:`,
    );
    for (const v of violations) {
      const kind = v.typeOnly ? 'type-only' : 'value';
      console.error(`  ${v.imported}${v.subpath === '(root)' ? '' : v.subpath}  ${v.package}  ${v.file}:${v.line}  (${kind})`);
    }
    console.error(
      '\nAdd each package to the workspace package.json, or import it from its owner. Root node_modules symlinks every workspace, so this only fails on a declared-graph build.',
    );
    process.exitCode = 1;
  } else {
    console.log(
      `ok: no undeclared workspace dependencies (${workspacesChecked} workspaces scanned)`,
    );
  }
}
