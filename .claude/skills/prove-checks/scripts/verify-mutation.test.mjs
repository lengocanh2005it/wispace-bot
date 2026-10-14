import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('./verify-mutation.mjs', import.meta.url));

const dirs = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-mutation-'));
  dirs.push(dir);
  return dir;
};

const target = (body) => {
  const file = join(tmp(), 'target.ts');
  writeFileSync(file, body, 'utf8');
  return file;
};

// The command runs through the shell, so `node -e process.exit(1)` is a
// syntax error under sh - `(` is a metacharacter. It happens to pass under
// Windows cmd, so the only thing that catches it is CI on Linux. Use a script
// path instead: temp paths carry no shell metacharacters.
const exitsWith = (code) => {
  const script = join(tmp(), `exit${code}.cjs`);
  writeFileSync(script, `process.exit(${code});\n`, 'utf8');
  return ['node', script];
};

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const run = ({ file, from, to, cmd = exitsWith(0) }) => {
  const r = spawnSync(process.execPath, [TOOL, '--', ...cmd], {
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, MUT_FILE: file, MUT_FROM: from, MUT_TO: to },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

test('reports the check as real when the command fails against broken code', () => {
  const file = target('const ok = true;\n');
  const r = run({
    file,
    from: 'const ok = true;',
    to: 'const ok = 1/0;',
    cmd: exitsWith(1),
  });
  assert.equal(r.status, 0);
  assert.match(r.out, /mutation APPLIED/);
  assert.match(r.out, /CHECK IS REAL/);
});

test('reports the check as fake when it still passes against broken code', () => {
  const file = target('const ok = true;\n');
  const r = run({ file, from: 'const ok = true;', to: 'const ok = 1/0;' });
  assert.equal(r.status, 1);
  assert.match(r.out, /CHECK IS FAKE/);
});

test('restores the file byte-for-byte', () => {
  const body = 'const ok = true;\n';
  const file = target(body);
  run({ file, from: 'const ok = true;', to: 'const ok = false;' });
  assert.equal(readFileSync(file, 'utf8'), body);
});

test('restores the file even when the command itself does not exist', () => {
  const body = 'const ok = true;\n';
  const file = target(body);
  const r = run({
    file,
    from: 'const ok = true;',
    to: 'const ok = false;',
    cmd: ['definitely-not-a-real-binary-xyz'],
  });
  assert.match(r.out, /restore VERIFIED/);
  assert.equal(readFileSync(file, 'utf8'), body);
});

test('refuses a substring that matches nothing, naming CRLF as the usual cause', () => {
  const file = target('const a = 1;\r\nconst b = 2;\r\n');
  const r = run({ file, from: 'const a = 1;\nconst b', to: 'const a = 9;\nconst b' });
  assert.equal(r.status, 1);
  assert.match(r.out, /expected exactly 1/);
  assert.match(r.out, /CRLF/);
  assert.equal(readFileSync(file, 'utf8'), 'const a = 1;\r\nconst b = 2;\r\n');
});

test('refuses an ambiguous substring rather than editing the first hit', () => {
  const file = target('foo();\nfoo();\n');
  const r = run({ file, from: 'foo();', to: 'bar();' });
  assert.equal(r.status, 1);
  assert.match(r.out, /matches 2 times/);
  assert.equal(readFileSync(file, 'utf8'), 'foo();\nfoo();\n');
});

test('refuses an empty MUT_FROM instead of matching everywhere', () => {
  const file = target('anything\n');
  const r = run({ file, from: '', to: 'x' });
  assert.equal(r.status, 1);
  assert.match(r.out, /must not be empty/);
});

test('applies a CRLF file when the caller matches its real line endings', () => {
  const body = 'const a = 1;\r\nconst b = 2;\r\n';
  const file = target(body);
  const r = run({
    file,
    from: 'const a = 1;\r\nconst b',
    to: 'const a = 9;\r\nconst b',
    cmd: exitsWith(1),
  });
  assert.equal(r.status, 0);
  assert.match(r.out, /mutation APPLIED/);
  assert.equal(readFileSync(file, 'utf8'), body);
});
