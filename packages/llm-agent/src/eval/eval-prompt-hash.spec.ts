import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  getRepoRoot,
  isRepoPath,
  listFixtures,
  normalizePromptContent,
  readPrompt,
  resolvePromptPath,
  sha256Hex,
} from './eval-prompt-hash';

const REPO_ROOT = resolve(__dirname, '../../../..');

describe('eval prompt hash — single implementation (ADR-0045)', () => {
  it('rejects a prompt path that escapes the repo root', () => {
    const read = readPrompt(REPO_ROOT, '../outside.txt');

    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error).toBe(
        'prompt path "../outside.txt" escapes the repo root',
      );
    }
  });

  it('rejects a prompt path on another Windows drive', () => {
    // `path.relative` across drives returns an absolute path, which does not
    // start with '..' — the escape check must reject it on its own.
    const other =
      process.platform === 'win32' ? 'D:\\outside.txt' : '/outside.txt';
    const read = readPrompt(REPO_ROOT, other);

    expect(read.ok).toBe(false);
  });

  it('accepts a dotfile inside the repo root', () => {
    // The old harness form rejected anything starting with '.', which caught
    // dotfiles by accident rather than by intent.
    expect(isRepoPath(REPO_ROOT, join(REPO_ROOT, '.gitattributes'))).toBe(true);
  });

  it('rejects the repo root itself as a prompt path', () => {
    expect(isRepoPath(REPO_ROOT, REPO_ROOT)).toBe(false);
  });

  it('returns content and hash from the same read', () => {
    const read = readPrompt(REPO_ROOT, 'package.json');

    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.hash).toBe(sha256Hex(normalizePromptContent(read.content)));
    }
  });

  it('lists only json fixtures, sorted', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-list-'));
    try {
      writeFileSync(join(root, 'b.json'), '{}');
      writeFileSync(join(root, 'a.json'), '{}');
      writeFileSync(join(root, 'notes.txt'), 'ignored');

      expect(listFixtures(root)).toEqual(['a.json', 'b.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the repo root lazily and memoizes it', () => {
    // The marker walk runs on first use, not at module load, so importing an
    // eval module cannot throw before it has done any work.
    const first = getRepoRoot();

    expect(first).toBe(getRepoRoot());
    expect(existsSync(join(first, 'turbo.json'))).toBe(true);
  });

  it('defaults resolvePromptPath to the lazily resolved root', () => {
    expect(resolvePromptPath('package.json')).toBe(
      join(getRepoRoot(), 'package.json'),
    );
  });

  it('performs no filesystem walk at module load', async () => {
    // The regression this locks down: the repo root used to be resolved in a
    // module-level const, so a bare `import` walked the filesystem and threw
    // when no turbo.json was reachable — failing before the importer did any
    // work. Re-importing with a counting `existsSync` proves the walk is gone.
    jest.resetModules();
    let probeCalls = 0;
    jest.doMock('fs', () => {
      const actual = jest.requireActual<typeof import('fs')>('fs');
      return {
        ...actual,
        existsSync: (...args: Parameters<typeof actual.existsSync>) => {
          probeCalls += 1;
          return actual.existsSync(...args);
        },
      };
    });

    try {
      // `.js` is the extension tsc requires for a dynamic import under
      // moduleResolution nodenext; the jest moduleNameMapper strips it back to
      // the TypeScript source.
      await import('./eval-prompt-hash.js');
    } finally {
      jest.dontMock('fs');
    }

    expect(probeCalls).toBe(0);
  });
});
