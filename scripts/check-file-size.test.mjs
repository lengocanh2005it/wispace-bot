import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BASELINE_FILE,
  cell,
  checkFileSize,
  countLines,
  renderReport,
} from './check-file-size.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_REF = `scripts/${BASELINE_FILE}`;

/** A complete entry. Individual tests delete one field to isolate a rule. */
function entry(overrides = {}) {
  return {
    lines: 3,
    context: 'Free-form Chat',
    trackedBy: '#778',
    reason: 'Named by #778; no duplication finding yet.',
    ...overrides,
  };
}

function lines(n) {
  return `${Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
}

function fixture(files, baseline = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wispace-file-size-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, 'scripts', BASELINE_FILE),
    JSON.stringify({
      measuredAt: '2026-09-27',
      measuredAtCommit: 'abc1234',
      ...baseline,
      files,
    }),
  );
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

test('a file exactly at its ceiling is not reported', () => {
  const f = fixture({ 'a.ts': entry() });
  try {
    f.write('a.ts', lines(3));
    assert.deepEqual(checkFileSize(f.root).grown, []);
  } finally {
    f.close();
  }
});

test('a file one line over its ceiling reports the added count', () => {
  const f = fixture({ 'a.ts': entry() });
  try {
    f.write('a.ts', lines(4));
    assert.deepEqual(checkFileSize(f.root).grown, [
      { file: 'a.ts', lines: 3, actual: 4, added: 1 },
    ]);
  } finally {
    f.close();
  }
});

test('a decomposed file keeps its ceiling and passes below it', () => {
  const f = fixture({ 'a.ts': entry({ lines: 100 }) });
  try {
    f.write('a.ts', lines(40));
    assert.deepEqual(checkFileSize(f.root).grown, []);
  } finally {
    f.close();
  }
});

test('a baseline entry with no file on disk is stale', () => {
  const f = fixture({ 'gone.ts': entry({ lines: 12 }) });
  try {
    assert.deepEqual(checkFileSize(f.root).stale, [
      { file: 'gone.ts', lines: 12 },
    ]);
  } finally {
    f.close();
  }
});

test('an untracked file is never gated by size', () => {
  const f = fixture({ 'a.ts': entry() });
  try {
    f.write('a.ts', lines(1));
    f.write('brand-new.ts', lines(9000));
    assert.equal(checkFileSize(f.root).grown.length, 0);
  } finally {
    f.close();
  }
});

test('an entry with no reason is an incomplete decision', () => {
  const f = fixture({ 'a.ts': { ...entry(), reason: '' } });
  try {
    assert.deepEqual(checkFileSize(f.root).invalid, [
      { file: 'a.ts', field: 'reason', problem: 'missing' },
    ]);
  } finally {
    f.close();
  }
});

test('an entry with no tracking issue is an incomplete decision', () => {
  const f = fixture({ 'a.ts': { ...entry(), trackedBy: '' } });
  try {
    assert.deepEqual(checkFileSize(f.root).invalid, [
      { file: 'a.ts', field: 'trackedBy', problem: 'missing' },
    ]);
  } finally {
    f.close();
  }
});

test('an entry whose tracker is not an issue number is rejected', () => {
  const f = fixture({ 'a.ts': { ...entry(), trackedBy: 'someday' } });
  try {
    assert.deepEqual(checkFileSize(f.root).invalid, [
      { file: 'a.ts', field: 'trackedBy', problem: 'not an issue reference' },
    ]);
  } finally {
    f.close();
  }
});

test('an entry with no bounded context is an incomplete decision', () => {
  const f = fixture({ 'a.ts': { ...entry(), context: '' } });
  try {
    assert.deepEqual(checkFileSize(f.root).invalid, [
      { file: 'a.ts', field: 'context', problem: 'missing' },
    ]);
  } finally {
    f.close();
  }
});

test('an entry with no line ceiling is an incomplete decision', () => {
  const f = fixture({ 'a.ts': { ...entry(), lines: undefined } });
  try {
    assert.deepEqual(checkFileSize(f.root).invalid, [
      { file: 'a.ts', field: 'lines', problem: 'missing' },
    ]);
  } finally {
    f.close();
  }
});

test('a zero or fractional ceiling is rejected rather than silently ungating a file', () => {
  const f = fixture({ 'a.ts': entry({ lines: 0 }) });
  try {
    assert.deepEqual(checkFileSize(f.root).invalid, [
      { file: 'a.ts', field: 'lines', problem: 'not a positive line count' },
    ]);
  } finally {
    f.close();
  }
});

test('an old-format bare number is reported as an unrecorded decision', () => {
  const f = fixture({ 'a.ts': 973 });
  try {
    assert.deepEqual(checkFileSize(f.root).invalid, [
      { file: 'a.ts', field: 'entry', problem: 'not a decision record' },
    ]);
  } finally {
    f.close();
  }
});

test('a baseline with no measurement date is not a measurement', () => {
  const f = fixture({ 'a.ts': entry() }, { measuredAt: '' });
  try {
    assert.deepEqual(checkFileSize(f.root).invalid, [
      { file: BASELINE_REF, field: 'measuredAt', problem: 'missing' },
    ]);
  } finally {
    f.close();
  }
});

test('a baseline with no measurement commit is not a measurement', () => {
  const f = fixture({ 'a.ts': entry() }, { measuredAtCommit: '' });
  try {
    assert.deepEqual(checkFileSize(f.root).invalid, [
      { file: BASELINE_REF, field: 'measuredAtCommit', problem: 'missing' },
    ]);
  } finally {
    f.close();
  }
});

test('an empty baseline is a ratchet that guards nothing', () => {
  const f = fixture({});
  try {
    assert.deepEqual(checkFileSize(f.root).invalid, [
      {
        file: BASELINE_REF,
        field: 'files',
        problem: 'empty - a baseline with no entries guards nothing',
      },
    ]);
  } finally {
    f.close();
  }
});

test('the report row carries every field of the decision', () => {
  const f = fixture({ 'a.ts': entry({ lines: 3 }) });
  try {
    f.write('a.ts', lines(3));
    const row = renderReport(checkFileSize(f.root))
      .split('\n')
      .find((line) => line.startsWith('| `a.ts`'));
    assert.deepEqual(
      row
        .split('|')
        .slice(1, 7)
        .map((part) => part.trim()),
      [
        '`a.ts`',
        '3',
        '3',
        'Free-form Chat',
        '#778',
        'Named by #778; no duplication finding yet.',
      ],
    );
  } finally {
    f.close();
  }
});

test('the report separates the live count from the recorded ceiling', () => {
  const f = fixture({ 'a.ts': entry({ lines: 100 }) });
  try {
    f.write('a.ts', lines(40));
    const row = renderReport(checkFileSize(f.root))
      .split('\n')
      .find((line) => line.startsWith('| `a.ts`'));
    assert.deepEqual(
      row
        .split('|')
        .slice(2, 4)
        .map((part) => part.trim()),
      ['40', '100'],
    );
  } finally {
    f.close();
  }
});

test('the report says the count is read at render time, not at the recorded commit', () => {
  const f = fixture({ 'a.ts': entry() });
  try {
    f.write('a.ts', lines(3));
    assert.match(renderReport(checkFileSize(f.root)), /read at render time/);
  } finally {
    f.close();
  }
});

test('the report names the commit the recorded measurement was taken at', () => {
  const f = fixture({ 'a.ts': entry() });
  try {
    f.write('a.ts', lines(3));
    assert.match(renderReport(checkFileSize(f.root)), /abc1234/);
  } finally {
    f.close();
  }
});

test('a pipe in a reason cannot break out of its table cell', () => {
  assert.equal(cell('a | b'), 'a \\| b');
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

test('every entry in the checked-in baseline names a reason, a tracker and a context', () => {
  assert.deepEqual(checkFileSize(REPO_ROOT).invalid, []);
});

test('the checked-in baseline has a ceiling for every tracked file', () => {
  const baseline = JSON.parse(
    readFileSync(join(REPO_ROOT, 'scripts', BASELINE_FILE), 'utf8'),
  );
  const entries = Object.entries(baseline.files);
  // No entry count is asserted on purpose. A hardcoded tally goes stale on every
  // legitimate addition, which is the same fragility ADR-0044 rejects for a
  // hand-written line-count list, and the baseline note carried exactly that
  // defect until #1471 removed it. What must hold is that every entry is a
  // complete decision, which the grown/stale/invalid checks above already
  // assert, and that the baseline is not empty, which is asserted here.
  assert.ok(entries.length > 0, 'the baseline guards nothing when it is empty');
  for (const [path, record] of entries) {
    assert.ok(
      Number.isInteger(record.lines) && record.lines >= 1,
      `${path} has no line ceiling`,
    );
    assert.ok(record.context, `${path} has no bounded context`);
    assert.ok(record.trackedBy, `${path} names no tracking issue`);
    assert.ok(record.reason, `${path} records no reason`);
  }
});

test('the checked-in baseline is sorted so it reads in one order', () => {
  const baseline = JSON.parse(
    readFileSync(join(REPO_ROOT, 'scripts', BASELINE_FILE), 'utf8'),
  );
  const paths = Object.keys(baseline.files);
  assert.deepEqual(paths, [...paths].sort());
});
