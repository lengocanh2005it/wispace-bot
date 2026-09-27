import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BASELINE_FILE, checkFileSize, countLines } from './check-file-size.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function lines(n) {
  return `${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
}

function fixture(entries) {
  const root = mkdtempSync(join(tmpdir(), 'wispace-file-size-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', BASELINE_FILE), JSON.stringify({ files: entries }));
  return {
    root,
    write(relativePath, source) {
      const file = join(root, relativePath);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a file exactly at its baseline is not reported', () => {
  const f = fixture({ 'a.ts': 3 });
  try {
    f.write('a.ts', lines(3));
    assert.deepEqual(checkFileSize(f.root).grown, []);
  } finally {
    f.close();
  }
});

test('a file one line over its baseline reports the added count', () => {
  const f = fixture({ 'a.ts': 3 });
  try {
    f.write('a.ts', lines(4));
    assert.deepEqual(checkFileSize(f.root).grown, [
      { file: 'a.ts', allowed: 3, actual: 4, added: 1 },
    ]);
  } finally {
    f.close();
  }
});

test('a decomposed file keeps its ceiling and passes below it', () => {
  const f = fixture({ 'a.ts': 100 });
  try {
    f.write('a.ts', lines(40));
    assert.deepEqual(checkFileSize(f.root).grown, []);
  } finally {
    f.close();
  }
});

test('a baseline entry with no file on disk is stale', () => {
  const f = fixture({ 'gone.ts': 12 });
  try {
    assert.deepEqual(checkFileSize(f.root).stale, [{ file: 'gone.ts', allowed: 12 }]);
  } finally {
    f.close();
  }
});

test('an untracked file is never gated by size', () => {
  const f = fixture({ 'a.ts': 1 });
  try {
    f.write('a.ts', lines(1));
    f.write('brand-new.ts', lines(9000));
    assert.equal(checkFileSize(f.root).grown.length, 0);
  } finally {
    f.close();
  }
});

test('a trailing newline does not add a line', () => {
  assert.equal(countLines('a\nb\n'), 2);
});

test('CRLF and LF count the same lines', () => {
  assert.equal(countLines('a\r\nb\r\nc\r\n'), countLines('a\nb\nc\n'));
});

test('an empty file is zero lines', () => {
  assert.equal(countLines(''), 0);
});

test('the checked-in baseline matches the repository as it stands', () => {
  assert.deepEqual(checkFileSize(REPO_ROOT).grown, []);
});

test('every path in the checked-in baseline exists', () => {
  assert.deepEqual(checkFileSize(REPO_ROOT).stale, []);
});

test('the checked-in baseline has a ceiling for every tracked file', () => {
  const baseline = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', BASELINE_FILE), 'utf8'));
  assert.equal(Object.keys(baseline.files).length, 6);
});

test('the checked-in baseline is sorted so a diff stays readable', () => {
  const baseline = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', BASELINE_FILE), 'utf8'));
  const paths = Object.keys(baseline.files);
  assert.deepEqual(paths, [...paths].sort());
});
