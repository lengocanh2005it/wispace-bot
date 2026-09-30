#!/usr/bin/env node
// Mutation guard: prove a check actually fails when the code is broken.
//
// The failure this exists to prevent: a command that exits 0 having done
// nothing, read as a passing result. A PowerShell `-replace` that misses CRLF,
// or spawnSync('npx') without shell:true on Windows, both return success while
// the work never happened.
//
// Usage (env vars, so code containing quotes needs no shell escaping):
//   MUT_FILE=<path> MUT_FROM=<exact substring> MUT_TO=<replacement> \
//     node verify-mutation.mjs -- <command> [args...]
//
// The file is restored in a finally block, and the restore is verified. A run
// that cannot prove the mutation landed exits non-zero rather than reporting.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const fail = (msg) => {
  console.error(`verify-mutation: ${msg}`);
  process.exit(1);
};

const file = process.env.MUT_FILE;
const from = process.env.MUT_FROM;
const to = process.env.MUT_TO;
const sep = process.argv.indexOf('--');
const command = sep === -1 ? [] : process.argv.slice(sep + 1);

if (!file || from === undefined || to === undefined) {
  fail('MUT_FILE, MUT_FROM and MUT_TO are all required');
}
if (from === '') fail('MUT_FROM must not be empty (it would match everywhere)');
if (command.length === 0) fail('supply a command after `--` to run against the mutation');

const original = readFileSync(file, 'utf8');

const occurrences = original.split(from).length - 1;
if (occurrences !== 1) {
  // 0 means the substring does not match - usually CRLF, a typo, or a stale
  // line number. Anything but 1 means the edit is ambiguous.
  fail(
    `MUT_FROM matches ${occurrences} times in ${file}, expected exactly 1.\n` +
      `  0 matches: wrong text, or the file is CRLF and you built the string with \\n.\n` +
      `  >1 match: add surrounding context to make it unique.`,
  );
}

const mutated = original.replace(from, to);

writeFileSync(file, mutated, 'utf8');
const afterWrite = readFileSync(file, 'utf8');
if (afterWrite === original) fail('write did not change the file on disk');
if (afterWrite.includes(from) && from !== to) {
  fail('after writing, MUT_FROM is still present - the replacement did not apply');
}
if (!afterWrite.includes(to)) {
  fail('after writing, MUT_TO is not present - the replacement did not apply');
}

console.log(`mutation APPLIED  ${file}`);
console.log(`  - ${from.slice(0, 90)}`);
console.log(`  + ${to.slice(0, 90)}`);

let result;
let restoreError = null;
try {
  result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });
  if (result.error) throw result.error;
} finally {
  // Restore, then verify the restore. A restore that silently fails leaves the
  // repo broken for the next agent, which is worse than the original problem.
  try {
    writeFileSync(file, original, 'utf8');
    const restored = readFileSync(file, 'utf8');
    if (restored !== original) restoreError = 'restore wrote different bytes than the original';
  } catch (e) {
    restoreError = `restore threw: ${e.message}`;
  }
}

if (restoreError) {
  fail(`RESTORE FAILED for ${file} - restore it by hand from git. ${restoreError}`);
}
console.log(`restore VERIFIED ${file}`);

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const failing = (result.status ?? 1) !== 0;
const failingTests = /Tests:.*\d+ failed/.test(output) || /\bFAIL\b/.test(output);
const mention = /(--silent|-s\b)/.test(command.join(' '));

console.log('');
console.log(`command exit: ${result.status}  ${failing ? '(non-zero)' : '(zero)'}`);
console.log(`evidence:     ${failingTests ? 'a suite is reported failing' : 'no suite-level failure marker in output'}`);
if (mention) {
  console.log('note: -s silences per-test detail; re-run without it to read the failing test name');
}
console.log('');
console.log(
  failing
    ? 'CHECK IS REAL: the command fails against the broken code.'
    : 'CHECK IS FAKE: it still passes with the code broken. Either the command ' +
        'does not exercise this path, or the assertion is tautological.',
);
process.exit(failing ? 0 : 1);
