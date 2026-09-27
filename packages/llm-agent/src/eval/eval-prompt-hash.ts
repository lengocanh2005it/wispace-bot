import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';

/**
 * Single owner of the eval prompt-hash read path.
 *
 * The harness (`eval-harness.ts`) and the rehash tool
 * (`rehash-fixtures.ts`) both read a prompt file, normalize its line endings,
 * and hash it. They used to implement that sequence separately, and the two
 * copies of the repo-escape check disagreed: the harness form accepted a
 * path on another Windows drive (because `path.relative` across drives
 * returns an absolute path, which does not start with `..`) and rejected
 * dotfiles inside the repo. See ADR-0045.
 */

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** CRLF → LF, so a hash is stable across Windows and CI checkouts. */
export function normalizePromptContent(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

export function resolvePromptPath(
  promptPath: string,
  repoRoot: string = getRepoRoot(),
): string {
  return resolve(repoRoot, promptPath);
}

/**
 * True when `filePath` resolves strictly inside `repoRoot`.
 *
 * `isAbsolute(relativePath)` is the load-bearing clause on Windows:
 * `path.relative('E:\\repo', 'D:\\other')` returns `D:\\other`, which does
 * not start with `..` and would otherwise pass an escape check.
 */
export function isRepoPath(repoRoot: string, filePath: string): boolean {
  const relativePath = relative(repoRoot, filePath);
  return (
    relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !isAbsolute(relativePath)
  );
}

/**
 * Resolves the repo root by walking up until a `turbo.json` marker is found.
 * Jest runs with `rootDir: src` and can present `__dirname`-relative module
 * paths, so a fixed depth (`../../..`) is not reliable — the marker walk is.
 */
export function resolveRepoRoot(): string {
  let dir = __dirname;
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, 'turbo.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'eval: could not locate the repo root (no turbo.json found walking up)',
  );
}

let cachedRepoRoot: string | undefined;

/**
 * The repo root, resolved on first use and memoized.
 *
 * Resolving at module load instead made merely importing an eval module walk
 * the filesystem and throw when no `turbo.json` was reachable, so a consumer
 * or a build could fail before it did any work. Failure now happens at the
 * call that actually needs a path, not at import.
 */
export function getRepoRoot(): string {
  cachedRepoRoot ??= resolveRepoRoot();
  return cachedRepoRoot;
}

export type PromptLoadResult =
  | { ok: true; content: string; hash: string }
  | { ok: false; error: string };

/**
 * Reads a prompt file, verifies it stays inside the repo, and returns its
 * LF-normalized content alongside the hash of that normalized content.
 * Hash comparison is the caller's decision — the rehash tool wants the hash,
 * the harness wants to assert it against a fixture pin.
 */
export function readPrompt(
  repoRoot: string,
  promptPath: string,
): PromptLoadResult {
  const resolved = resolvePromptPath(promptPath, repoRoot);
  if (!isRepoPath(repoRoot, resolved)) {
    return {
      ok: false,
      error: `prompt path "${promptPath}" escapes the repo root`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch {
    return { ok: false, error: `prompt file not found: ${promptPath}` };
  }
  const content = normalizePromptContent(raw);
  return { ok: true, content, hash: sha256Hex(content) };
}

/** The fixture file names in `fixturesDir`, sorted. */
export function listFixtures(fixturesDir: string): string[] {
  return readdirSync(fixturesDir)
    .filter((file) => file.endsWith('.json'))
    .sort();
}
