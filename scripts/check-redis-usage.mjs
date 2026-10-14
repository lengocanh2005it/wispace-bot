#!/usr/bin/env node
/**
 * Keep the shared Redis connection safe for every consumer in this process.
 *
 * RedisService deliberately owns one connection. A blocking command would park
 * that socket and stall every other Redis operation, so consumers must poll or
 * use a separately budgeted connection for blocking work. This guard also keeps
 * consumers from quietly opening additional ioredis clients.
 */
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SOURCE_EXT, stripComments, walk } from './lib/source-scan.mjs';

const CONSUMER_SOURCE_DIRS = [
  'packages/bot-common/src',
  'packages/chat-history/src',
  'packages/chat-agent/src',
  'packages/chat-metering/src',
  'packages/llm-agent/src',
  'packages/wispace-client/src',
];
const CLIENT_OWNER_FILE = 'packages/bot-common/src/redis/redis.service.ts';
const REQUIRED_REDIS_SOURCE_DIR = 'packages/bot-common/src/redis';

const BLOCKING_METHOD =
  /\.\s*(blpop|brpop|brpoplpush|blmove|bzpopmin|bzpopmax|bzmpop|subscribe|psubscribe)\s*\(/gi;
const XREAD_METHOD = /\.\s*(xread|xreadgroup)\s*\(/gi;
const DISPATCH_METHOD = /\.\s*(call|callBuffer|sendCommand)\s*\(/gi;
const BLOCKING_COMMAND_LITERAL =
  /(['"`])\s*(BLPOP|BRPOP|BRPOPLPUSH|BLMOVE|BZPOPMIN|BZPOPMAX|BZMPOP|SUBSCRIBE|PSUBSCRIBE)\s*\1/gi;
const XREAD_COMMAND_LITERAL = /(['"`])\s*(XREADGROUP|XREAD)\s*\1/gi;
const DUPLICATE_CALL = /\.\s*duplicate\s*\(/gi;

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function matchingCallEnd(source, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\') {
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i + 2);
      if (end < 0) return source.length;
      i = end;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return source.length;
      i = end + 1;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return source.length;
}

function callArguments(source, match) {
  const openIndex = source.indexOf('(', match.index);
  const endIndex = matchingCallEnd(source, openIndex);
  return source.slice(openIndex + 1, endIndex);
}

function ioredisConstructors(source) {
  const names = new Set(['Redis', 'IORedis', 'Cluster', 'DeadlineRedis']);
  const imports =
    /^\s*import\s+(?!type\b)((?:(?!^\s*import\b)[\s\S])*?)\s+from\s*(['"])ioredis\2\s*;?/gm;
  for (const match of source.matchAll(imports)) {
    const clause = match[1].replace(/^type\s+/, '').trim();
    const defaultImport = clause.match(/^([A-Za-z_$][\w$]*)/);
    if (defaultImport && defaultImport[1] !== 'type') {
      names.add(defaultImport[1]);
    }
    const namedImports = clause.match(/\{([^}]*)\}/)?.[1] ?? '';
    for (const entry of namedImports.split(',')) {
      const [imported, alias] = entry
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/);
      if (imported === 'Cluster' || imported === 'Redis') {
        names.add(alias ?? imported);
      }
    }
  }
  return names;
}

export function checkRedisUsage(root) {
  const absoluteRoot = resolve(root);
  const violations = [];
  const files = [];
  const ownerRelative = CLIENT_OWNER_FILE;
  let ownedClientCount = 0;

  const addViolation = (file, source, offset, rule, evidence, message) => {
    const relativeFile = relative(absoluteRoot, file).split('\\').join('/');
    violations.push({
      rule,
      file: relativeFile,
      line: lineAt(source, offset),
      evidence,
      message,
    });
  };

  for (const sourceDir of CONSUMER_SOURCE_DIRS) {
    const absoluteDir = `${absoluteRoot}/${sourceDir}`;
    if (!existsSync(absoluteDir)) {
      violations.push({
        rule: 'redis-consumer-scan-target',
        file: sourceDir,
        line: 1,
        evidence: 'missing source directory',
        message:
          'Redis consumer scan target is missing; the guard cannot verify it',
      });
      continue;
    }
    const sourceFiles = walk(absoluteDir).filter((file) =>
      SOURCE_EXT.test(file),
    );
    if (sourceFiles.length === 0) {
      violations.push({
        rule: 'redis-consumer-scan-target',
        file: sourceDir,
        line: 1,
        evidence: 'empty source directory',
        message: 'Redis consumer scan target contains no source files',
      });
    }
    files.push(...sourceFiles);
  }

  const redisSourceDir = `${absoluteRoot}/${REQUIRED_REDIS_SOURCE_DIR}`;
  if (!existsSync(redisSourceDir) || walk(redisSourceDir).length === 0) {
    violations.push({
      rule: 'redis-consumer-scan-target',
      file: REQUIRED_REDIS_SOURCE_DIR,
      line: 1,
      evidence: 'missing or empty Redis source directory',
      message: 'The shared Redis client surface is not being scanned',
    });
  }

  for (const file of [...new Set(files)].sort()) {
    const source = stripComments(readFileSync(file, 'utf8'));
    const relativeFile = relative(absoluteRoot, file).split('\\').join('/');
    const isOwner = relativeFile === ownerRelative;

    for (const match of source.matchAll(BLOCKING_METHOD)) {
      addViolation(
        file,
        source,
        match.index,
        'redis-blocking-command',
        match[1],
        'Blocking Redis commands cannot use the shared process connection',
      );
    }

    for (const match of source.matchAll(XREAD_METHOD)) {
      if (/\bBLOCK\b/i.test(callArguments(source, match))) {
        addViolation(
          file,
          source,
          match.index,
          'redis-blocking-command',
          `${match[1].toUpperCase()} BLOCK`,
          'Blocking Redis commands cannot use the shared process connection',
        );
      }
    }

    for (const match of source.matchAll(BLOCKING_COMMAND_LITERAL)) {
      addViolation(
        file,
        source,
        match.index,
        'redis-blocking-command',
        match[2],
        'Blocking Redis commands cannot use the shared process connection',
      );
    }

    for (const match of source.matchAll(DISPATCH_METHOD)) {
      const args = callArguments(source, match);
      const command = args.match(XREAD_COMMAND_LITERAL);
      if (command && /\bBLOCK\b/i.test(args)) {
        addViolation(
          file,
          source,
          match.index,
          'redis-blocking-command',
          `${command[2]} BLOCK`,
          'Blocking Redis commands cannot use the shared process connection',
        );
      }
    }

    const constructorNames = ioredisConstructors(source);
    const constructors = new RegExp(
      `\\bnew\\s+((?:[A-Za-z_$][\\w$]*\\.)?(?:${[...constructorNames].join(
        '|',
      )}))\\s*\\(`,
      'g',
    );
    for (const match of source.matchAll(constructors)) {
      if (isOwner && match[1] === 'DeadlineRedis') {
        ownedClientCount += 1;
        if (ownedClientCount === 1) continue;
      }
      addViolation(
        file,
        source,
        match.index,
        'redis-extra-connection',
        `new ${match[1]}(`,
        'RedisService owns the only shared-client connection; use its injected client',
      );
    }

    for (const match of source.matchAll(DUPLICATE_CALL)) {
      addViolation(
        file,
        source,
        match.index,
        'redis-extra-connection',
        '.duplicate(',
        'Duplicating the shared Redis client opens another connection',
      );
    }
  }

  const ownerFile = `${absoluteRoot}/${CLIENT_OWNER_FILE}`;
  if (!existsSync(ownerFile)) {
    violations.push({
      rule: 'redis-single-client-owner',
      file: CLIENT_OWNER_FILE,
      line: 1,
      evidence: 'missing RedisService client owner',
      message: 'The shared Redis client owner is missing from the scan',
    });
  } else if (ownedClientCount !== 1) {
    violations.push({
      rule: 'redis-single-client-owner',
      file: CLIENT_OWNER_FILE,
      line: 1,
      evidence: `found ${ownedClientCount} owned DeadlineRedis construction(s)`,
      message:
        'RedisService must remain the owner of exactly one Redis connection',
    });
  }

  return { violations, filesScanned: new Set(files).size };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { violations, filesScanned } = checkRedisUsage(process.cwd());
  if (violations.length > 0) {
    console.error(
      `Redis connection invariant violations (${violations.length}):`,
    );
    for (const violation of violations) {
      console.error(
        `  ${violation.file}:${violation.line} [${violation.rule}] ${violation.evidence}`,
      );
      console.error(`      ${violation.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `ok: Redis connection invariant holds (${filesScanned} source files scanned)`,
    );
  }
}
