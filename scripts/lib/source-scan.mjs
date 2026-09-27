/**
 * Shared source scanning for the repository's dependency-boundary guards.
 *
 * `check-workspace-deps.mjs` (imported without being declared) and
 * `check-manifest-deps.mjs` (declared without being imported) walk the same
 * files and need the same answers to "which package specifiers does this source
 * reference?". Two copies of the comment stripper and the walk drifted apart
 * once already, and each guard is wired into CI, so a divergence here would make
 * one of them silently wrong.
 *
 * Consumers add their own specifier patterns for forms only they accept, and do
 * their own filtering on the yielded hits.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SOURCE_DIRS = ['src', 'test', 'scripts'];
export const SOURCE_EXT = /\.(ts|mts|cts|mjs|cjs|js)$/;
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo']);

/**
 * The import forms every guard accepts. Stateful (`/g`) patterns are shared, so
 * `eachSpecifier` resets `lastIndex` before every use.
 */
export const IMPORT_SPECIFIER_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g, // import ... from 'x' / export ... from 'x'
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('x')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('x')
  /^\s*import\s+['"]([^'"]+)['"]/gm, // bare side-effect import
];

/** Remove comments so a commented-out import is not read as a real one. */
export function stripComments(text) {
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

/** Every package specifier in a source file, with the line it came from. */
export function* eachSpecifier(source, patterns = IMPORT_SPECIFIER_PATTERNS) {
  const lines = stripComments(source).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        yield { specifier: match[1], line, number: index + 1 };
      }
    }
  }
}

/** Collect the scannable source files under a directory. */
export function walk(dir, out = []) {
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

/** Collapse a specifier to its package: `@scope/pkg/deep` -> `@scope/pkg`. */
export function packageNameOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('#')) return null;
  if (specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
