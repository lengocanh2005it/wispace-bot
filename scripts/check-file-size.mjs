#!/usr/bin/env node
/**
 * Fail when a tracked source file grows past the line count recorded for it,
 * and hold each entry to being a complete decision rather than a bare number.
 *
 * This is a ratchet, not a size gate. A file enters `file-size-baseline.json`
 * only when a decision names it, and it can never grow again; it leaves the
 * baseline when it is decomposed or deleted. A new file is never gated by size
 * at all. ADR-0044 records why: the 780-line threshold this replaces admitted
 * the files it was written to catch, and its own flagship precedent (#438) left
 * `agent.service.ts` above the threshold while the repository grew by 69 lines.
 *
 * The ratchet cannot live in `.oxlintrc.json`. An oxlint `overrides` entry
 * exempts a path unconditionally, so a file exempted at 1412 lines would stay
 * exempt at 1600. Rewriting the exemption list as files shrink is the
 * hand-maintained list that drifted four times in #778. Only a script that
 * reads the current size and compares it to the recorded size can express
 * "tolerate the backlog, block growth".
 *
 * Each entry also carries the bounded context it belongs to, the issue holding
 * the decision to keep it, and why it is kept. An entry missing any of them is
 * rejected, because a line count with no recorded reason is how a hand-written
 * list becomes an unmaintained one. `trackedBy` is the issue that holds the
 * decision, not necessarily the issue that owns the decomposition: four of the
 * six tracked files have no decomposition owner by design, and naming the
 * index as their tracker says so rather than implying work nobody agreed to.
 *
 * `--report` renders those entries as the #778 index table so the table is
 * generated rather than retyped. The line count it prints is read at render
 * time and is labelled as such; the recorded measurement names the commit it
 * was taken at, because a count without its commit is not a measurement.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASELINE_FILE = 'file-size-baseline.json';
const BASELINE_DIR = 'scripts';
const BASELINE_REF = `${BASELINE_DIR}/${BASELINE_FILE}`;
const ISSUE_REFERENCE = /^#\d+$/;

function baselinePath(root) {
  return join(root, BASELINE_DIR, BASELINE_FILE);
}

/** Count source lines the way a reader does: a trailing newline is not a line. */
export function countLines(text) {
  if (text.length === 0) return 0;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function isBlank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

/** Keep a reason from breaking out of its table cell. */
export function cell(text) {
  return String(text).replace(/\|/g, '\\|');
}

/** Every field an entry must carry to count as a recorded decision. */
function validateEntry(file, record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return [{ file, field: 'entry', problem: 'not a decision record' }];
  }
  const problems = [];
  if (record.lines === undefined || record.lines === null) {
    problems.push({ file, field: 'lines', problem: 'missing' });
  } else if (!Number.isInteger(record.lines) || record.lines < 1) {
    problems.push({ file, field: 'lines', problem: 'not a positive line count' });
  }
  if (isBlank(record.context)) {
    problems.push({ file, field: 'context', problem: 'missing' });
  }
  if (isBlank(record.trackedBy)) {
    problems.push({ file, field: 'trackedBy', problem: 'missing' });
  } else if (!ISSUE_REFERENCE.test(record.trackedBy.trim())) {
    problems.push({ file, field: 'trackedBy', problem: 'not an issue reference' });
  }
  if (isBlank(record.reason)) {
    problems.push({ file, field: 'reason', problem: 'missing' });
  }
  return problems;
}

function readBaseline(root) {
  const path = baselinePath(root);
  if (!existsSync(path)) {
    throw new Error(`Missing ${BASELINE_REF} at the repository root`);
  }
  const baseline = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof baseline.files !== 'object' || baseline.files === null) {
    throw new Error(`${BASELINE_FILE} has no "files" object`);
  }
  return baseline;
}

export function checkFileSize(root) {
  const baseline = readBaseline(root);

  const grown = [];
  const stale = [];
  const invalid = [];
  const checked = [];

  // A count without its commit is not a measurement, so an unstamped baseline
  // cannot vouch for the ceilings it holds.
  for (const field of ['measuredAt', 'measuredAtCommit']) {
    if (isBlank(baseline[field])) {
      invalid.push({ file: BASELINE_REF, field, problem: 'missing' });
    }
  }
  // A baseline with no entries is a ratchet that ratchets nothing, which is
  // indistinguishable from deleting the check, so it is reported rather than
  // passing quietly.
  if (Object.keys(baseline.files).length === 0) {
    invalid.push({
      file: BASELINE_REF,
      field: 'files',
      problem: 'empty - a baseline with no entries guards nothing',
    });
  }

  for (const [file, record] of Object.entries(baseline.files)) {
    const problems = validateEntry(file, record);
    if (problems.length > 0) {
      invalid.push(...problems);
      continue;
    }
    const path = join(root, file);
    if (!existsSync(path)) {
      stale.push({ file, lines: record.lines });
      continue;
    }
    const actual = countLines(readFileSync(path, 'utf8'));
    checked.push({ file, actual, ...record });
    if (actual > record.lines) {
      grown.push({ file, lines: record.lines, actual, added: actual - record.lines });
    }
  }

  checked.sort((a, b) => b.actual - a.actual || a.file.localeCompare(b.file));
  return {
    grown,
    stale,
    invalid,
    checked,
    measuredAt: baseline.measuredAt ?? null,
    measuredAtCommit: baseline.measuredAtCommit ?? null,
  };
}

export function renderReport({ checked, measuredAt, measuredAtCommit }) {
  const header = [
    `Baseline recorded ${measuredAt} at ${measuredAtCommit}. \`Now\` is read at render time.`,
    '',
    '| File | Now | Ceiling | Context | Tracked by | Kept because |',
    '| --- | ---: | ---: | --- | --- | --- |',
    ...checked.map(
      (record) =>
        `| \`${record.file}\` | ${record.actual} | ${record.lines} | ${cell(record.context)} | ${record.trackedBy} | ${cell(record.reason)} |`,
    ),
  ].join('\n');
  return header;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const result = checkFileSize(process.cwd());
  const { grown, stale, invalid, checked } = result;

  for (const { file, field, problem } of invalid) {
    console.error(`  ${file}  ${field} is ${problem}`);
  }
  for (const { file, lines } of stale) {
    console.error(`  ${file}  is tracked but no longer exists (ceiling ${lines})`);
  }
  for (const { file, lines, actual, added } of grown) {
    console.error(`  ${file}  ${lines} -> ${actual} lines (+${added})`);
  }

  const problems = grown.length + stale.length + invalid.length;

  if (process.argv.includes('--report')) {
    console.log(renderReport(result));
  } else if (problems === 0) {
    const largest = checked[0];
    console.log(
      `ok: ${checked.length} tracked, none grew (largest ${largest.file} at ${largest.actual} lines)`,
    );
  }

  if (problems > 0) {
    console.error(`\n${problems} problem(s) in the tracked-file baseline.`);
    console.error(
      `Decompose the file and remove its entry, or record the decision to keep it — each entry needs lines, context, trackedBy and reason, plus a measuredAt and measuredAtCommit on the baseline.`,
    );
    console.error(
      'Raising a ceiling is allowed and is sometimes the right answer; say why on the tracking issue. ADR-0044: size is evidence, not a trigger.',
    );
    process.exitCode = 1;
  }
}
