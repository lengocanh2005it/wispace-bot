#!/usr/bin/env node
/**
 * Fail when a tracked source file grows past the line count recorded for it.
 *
 * This is a ratchet, not a size gate. A file enters `file-size-baseline.json`
 * only when a decision named it, and it can never grow again; it leaves the
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
 * The check is intentionally silent about size. It does not report how far a
 * file is from its baseline, only the files that grew, because a report nobody
 * reads is what ADR-0039 was written about.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASELINE_FILE = 'file-size-baseline.json';
const BASELINE_DIR = 'scripts';

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

function readBaseline(root) {
  const path = baselinePath(root);
  if (!existsSync(path)) {
    throw new Error(`Missing ${BASELINE_DIR}/${BASELINE_FILE} at the repository root`);
  }
  const baseline = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof baseline.files !== 'object' || baseline.files === null) {
    throw new Error(`${BASELINE_FILE} has no "files" object`);
  }
  return baseline;
}

export function checkFileSize(root) {
  const { files } = readBaseline(root);

  const grown = [];
  const stale = [];
  const checked = [];

  for (const [file, allowed] of Object.entries(files)) {
    const path = join(root, file);
    if (!existsSync(path)) {
      stale.push({ file, allowed });
      continue;
    }
    const actual = countLines(readFileSync(path, 'utf8'));
    checked.push({ file, allowed, actual });
    if (actual > allowed) grown.push({ file, allowed, actual, added: actual - allowed });
  }

  checked.sort((a, b) => b.actual - a.actual);
  return { grown, stale, checked };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { grown, stale, checked } = checkFileSize(process.cwd());

  for (const { file, allowed } of stale) {
    console.error(`  ${file}  is in ${BASELINE_FILE} but no longer exists (baseline ${allowed})`);
  }
  for (const { file, allowed, actual, added } of grown) {
    console.error(`  ${file}  ${allowed} -> ${actual} lines (+${added})`);
  }

  if (grown.length > 0 || stale.length > 0) {
    console.error(
      `\n${grown.length} file(s) grew past their baseline, ${stale.length} stale entr(ies).`,
    );
    console.error(
      'Decompose the file, or raise its entry in ' +
        BASELINE_FILE +
        ' with the reason recorded on the issue that owns it. ADR-0044: size is evidence, not a trigger.',
    );
    process.exitCode = 1;
  } else {
    const largest = checked[0];
    console.log(
      `ok: no tracked file grew (${checked.length} tracked, largest ${largest.file} at ${largest.actual} lines)`,
    );
  }
}
