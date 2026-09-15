import {
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join, relative, resolve, isAbsolute } from 'path';
import { CHAT_SYSTEM_PROMPT_CORE } from '../chat-system-prompt';
import {
  normalizePromptContent,
  parseFixture,
  resolvePromptPath,
  resolveRepoRoot,
  sha256Hex,
} from './eval-harness';

export interface RehashEvalFixturesOptions {
  check?: boolean;
  corePrompt?: string;
  fixturesDir?: string;
  repoRoot?: string;
}

export interface RehashEvalFixturesResult {
  changed: string[];
  errors: string[];
  fixtureCount: number;
  ok: boolean;
  stale: string[];
}

interface PlannedFixture {
  content: string;
  filePath: string;
  relativePath: string;
}

function isRepoPath(repoRoot: string, filePath: string): boolean {
  const relativePath = relative(repoRoot, filePath);
  return (
    relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !isAbsolute(relativePath)
  );
}

function fixturePath(repoRoot: string, filePath: string): string {
  const relativePath = relative(repoRoot, filePath);
  return (relativePath || filePath).replaceAll('\\', '/');
}

interface JsonStringToken {
  contentEnd: number;
  contentStart: number;
  next: number;
  value: string;
}

interface HashRanges {
  coreHash: { end: number; start: number };
  promptHashes: Array<{ end: number; start: number }>;
}

function skipWhitespace(raw: string, start: number): number {
  let index = start;
  while (/\s/.test(raw[index] ?? '')) index += 1;
  return index;
}

function readJsonString(raw: string, start: number): JsonStringToken {
  if (raw[start] !== '"') {
    throw new Error(`expected JSON string at offset ${start}`);
  }
  let escaped = false;
  for (let index = start + 1; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      const end = index + 1;
      return {
        value: JSON.parse(raw.slice(start, end)) as string,
        contentStart: start + 1,
        contentEnd: index,
        next: end,
      };
    }
  }
  throw new Error(`unterminated JSON string at offset ${start}`);
}

function skipJsonValue(raw: string, start: number): number {
  const valueStart = skipWhitespace(raw, start);
  const first = raw[valueStart];
  if (first === '"') return readJsonString(raw, valueStart).next;
  if (first === '[' || first === '{') {
    const closing = first === '[' ? ']' : '}';
    const opening = first;
    let index = valueStart + 1;
    while (true) {
      index = skipWhitespace(raw, index);
      if (raw[index] === closing) return index + 1;
      if (opening === '{') {
        index = readJsonString(raw, index).next;
        index = skipWhitespace(raw, index);
        if (raw[index] !== ':')
          throw new Error(`expected ':' at offset ${index}`);
        index = skipJsonValue(raw, index + 1);
      } else {
        index = skipJsonValue(raw, index);
      }
      index = skipWhitespace(raw, index);
      if (raw[index] === ',') {
        index += 1;
        continue;
      }
      if (raw[index] === closing) return index + 1;
      throw new Error(`expected ',' or '${closing}' at offset ${index}`);
    }
  }
  let index = valueStart;
  while (index < raw.length && !/[\s,\]}]/.test(raw[index])) index += 1;
  if (index === valueStart)
    throw new Error(`invalid JSON value at offset ${start}`);
  return index;
}

function scanPromptFiles(
  raw: string,
  start: number,
): Array<{ end: number; start: number }> {
  let index = skipWhitespace(raw, start);
  if (raw[index] !== '[') throw new Error('promptFiles is not an array');
  index += 1;
  const hashes: Array<{ end: number; start: number }> = [];
  while (true) {
    index = skipWhitespace(raw, index);
    if (raw[index] === ']') return hashes;
    if (raw[index] !== '{')
      throw new Error('promptFiles entry is not an object');
    index += 1;
    let hashRange: { end: number; start: number } | undefined;
    while (true) {
      index = skipWhitespace(raw, index);
      if (raw[index] === '}') break;
      const key = readJsonString(raw, index);
      index = skipWhitespace(raw, key.next);
      if (raw[index] !== ':')
        throw new Error(`expected ':' at offset ${index}`);
      const valueStart = skipWhitespace(raw, index + 1);
      if (key.value === 'hash') {
        const value = readJsonString(raw, valueStart);
        if (hashRange)
          throw new Error('promptFiles entry has duplicate hash fields');
        hashRange = { start: value.contentStart, end: value.contentEnd };
        index = value.next;
      } else {
        index = skipJsonValue(raw, valueStart);
      }
      index = skipWhitespace(raw, index);
      if (raw[index] === ',') {
        index += 1;
        continue;
      }
      if (raw[index] === '}') break;
      throw new Error(`expected ',' or '}' at offset ${index}`);
    }
    if (!hashRange) throw new Error('promptFiles entry hash field not found');
    hashes.push(hashRange);
    index = skipWhitespace(raw, index + 1);
    if (raw[index] === ',') {
      index += 1;
      continue;
    }
    if (raw[index] === ']') return hashes;
    throw new Error(`expected ',' or ']' at offset ${index}`);
  }
}

function findHashRanges(raw: string): HashRanges {
  let index = skipWhitespace(raw, 0);
  if (raw[index] !== '{') throw new Error('fixture root is not an object');
  index += 1;
  let coreHash: { end: number; start: number } | undefined;
  let promptHashes: Array<{ end: number; start: number }> | undefined;
  while (true) {
    index = skipWhitespace(raw, index);
    if (raw[index] === '}') break;
    const key = readJsonString(raw, index);
    index = skipWhitespace(raw, key.next);
    if (raw[index] !== ':') throw new Error(`expected ':' at offset ${index}`);
    const valueStart = skipWhitespace(raw, index + 1);
    if (key.value === 'coreHash') {
      const value = readJsonString(raw, valueStart);
      if (coreHash) throw new Error('fixture has duplicate coreHash fields');
      coreHash = { start: value.contentStart, end: value.contentEnd };
      index = value.next;
    } else if (key.value === 'promptFiles') {
      if (promptHashes)
        throw new Error('fixture has duplicate promptFiles fields');
      promptHashes = scanPromptFiles(raw, valueStart);
      index = skipJsonValue(raw, valueStart);
    } else {
      index = skipJsonValue(raw, valueStart);
    }
    index = skipWhitespace(raw, index);
    if (raw[index] === ',') {
      index += 1;
      continue;
    }
    if (raw[index] === '}') break;
    throw new Error(`expected ',' or '}' at offset ${index}`);
  }
  if (!coreHash) throw new Error('coreHash field not found');
  if (!promptHashes) throw new Error('promptFiles array not found');
  return { coreHash, promptHashes };
}

function replaceHashes(
  raw: string,
  coreHash: string,
  promptHashes: string[],
): string {
  const ranges = findHashRanges(raw);
  if (ranges.promptHashes.length !== promptHashes.length) {
    throw new Error(
      `expected ${promptHashes.length} prompt hash field(s), found ${ranges.promptHashes.length}`,
    );
  }
  const replacements = [
    { ...ranges.coreHash, value: coreHash },
    ...ranges.promptHashes.map((range, index) => ({
      ...range,
      value: promptHashes[index],
    })),
  ].sort((left, right) => right.start - left.start);
  return replacements.reduce(
    (content, replacement) =>
      content.slice(0, replacement.start) +
      replacement.value +
      content.slice(replacement.end),
    raw,
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeAtomically(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, content, 'utf8');
  try {
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the original rename error.
    }
    throw error;
  }
}

function readPromptHash(repoRoot: string, promptPath: string): string {
  const resolvedPath = resolvePromptPath(promptPath, repoRoot);
  if (!isRepoPath(repoRoot, resolvedPath)) {
    throw new Error(`prompt path "${promptPath}" escapes the repo root`);
  }
  let content: string;
  try {
    content = readFileSync(resolvedPath, 'utf8');
  } catch {
    throw new Error(`prompt file not found: ${promptPath}`);
  }
  return sha256Hex(normalizePromptContent(content));
}

function resolveOptions(options: RehashEvalFixturesOptions) {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  return {
    check: options.check === true,
    corePrompt: options.corePrompt ?? CHAT_SYSTEM_PROMPT_CORE,
    fixturesDir:
      options.fixturesDir ?? join(repoRoot, 'packages/llm-agent/fixtures'),
    repoRoot,
  };
}

export function rehashEvalFixtures(
  options: RehashEvalFixturesOptions = {},
): RehashEvalFixturesResult {
  const { check, corePrompt, fixturesDir, repoRoot } = resolveOptions(options);
  const changed: string[] = [];
  const errors: string[] = [];
  const stale: string[] = [];
  const plans: PlannedFixture[] = [];
  const actualCoreHash = sha256Hex(normalizePromptContent(corePrompt));
  let files: string[];

  try {
    files = readdirSync(fixturesDir)
      .filter((file) => file.endsWith('.json'))
      .sort();
  } catch {
    return {
      ok: false,
      fixtureCount: 0,
      changed,
      stale,
      errors: [`fixtures directory not found: ${fixturesDir}`],
    };
  }

  for (const file of files) {
    const filePath = resolve(fixturesDir, file);
    const relativePath = fixturePath(repoRoot, filePath);
    let rawText: string;
    let rawFixture: unknown;

    try {
      rawText = readFileSync(filePath, 'utf8');
      rawFixture = JSON.parse(rawText) as unknown;
    } catch (error) {
      errors.push(`${relativePath}: invalid JSON (${errorText(error)})`);
      continue;
    }

    const parsed = parseFixture(rawFixture);
    if ('errors' in parsed) {
      errors.push(`${relativePath}: ${parsed.errors.join('; ')}`);
      continue;
    }

    const source = rawFixture as Record<string, unknown>;
    const promptFiles = source.promptFiles as Array<Record<string, unknown>>;
    let promptHashes: string[];
    try {
      promptHashes = promptFiles.map((promptFile) =>
        readPromptHash(repoRoot, String(promptFile.path)),
      );
    } catch (error) {
      errors.push(`${relativePath}: ${errorText(error)}`);
      continue;
    }
    let formatted: string;
    try {
      formatted = replaceHashes(rawText, actualCoreHash, promptHashes);
    } catch (error) {
      errors.push(`${relativePath}: ${errorText(error)}`);
      continue;
    }

    if (formatted === rawText) {
      continue;
    }
    if (check) {
      stale.push(relativePath);
    } else {
      plans.push({ content: formatted, filePath, relativePath });
    }
  }

  if (errors.length > 0 || check) {
    return {
      ok: errors.length === 0 && stale.length === 0,
      fixtureCount: files.length,
      changed,
      stale,
      errors,
    };
  }

  for (const plan of plans) {
    try {
      writeAtomically(plan.filePath, plan.content);
      changed.push(plan.relativePath);
    } catch (error) {
      errors.push(`${plan.relativePath}: write failed (${errorText(error)})`);
    }
  }

  return {
    ok: errors.length === 0,
    fixtureCount: files.length,
    changed,
    stale,
    errors,
  };
}

export function summarizeRehashResult(
  result: RehashEvalFixturesResult,
  check: boolean,
): string {
  if (result.errors.length > 0) {
    return [
      'EVAL FIXTURE REHASH: ERROR',
      ...result.errors.map((error) => `- ${error}`),
    ].join('\n');
  }
  if (check && result.stale.length > 0) {
    return [
      'EVAL FIXTURE REHASH: STALE',
      ...result.stale.map((file) => `- ${file}`),
    ].join('\n');
  }
  if (check) {
    return `EVAL FIXTURE REHASH: CLEAN (${result.fixtureCount} fixtures)`;
  }
  return result.changed.length > 0
    ? [
        `EVAL FIXTURE REHASH: UPDATED ${result.changed.length} fixture(s)`,
        ...result.changed.map((file) => `- ${file}`),
      ].join('\n')
    : `EVAL FIXTURE REHASH: UP TO DATE (${result.fixtureCount} fixtures)`;
}
