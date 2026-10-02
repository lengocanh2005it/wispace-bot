#!/usr/bin/env node
/** Module-scope prom-client metrics must declare their registry explicitly. */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SOURCE_EXT, stripComments, walk } from './lib/source-scan.mjs';

const METRIC_TYPES = ['Counter', 'Gauge', 'Histogram'];

function importedMetricConstructors(source) {
  const names = new Set(METRIC_TYPES);
  const namespaces = new Set();
  const imports =
    /^\s*import\s+(?!type\b)((?:(?!^\s*import\b)[\s\S])*?)\s+from\s*(['"])prom-client\2\s*;?/gm;

  for (const match of source.matchAll(imports)) {
    const clause = match[1].trim();
    const defaultImport = clause.match(/^([A-Za-z_$][\w$]*)/);
    if (defaultImport && defaultImport[1] !== 'type') {
      namespaces.add(defaultImport[1]);
    }
    const namespaceImport = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespaceImport) namespaces.add(namespaceImport[1]);
    const namedImports = clause.match(/\{([^}]*)\}/)?.[1] ?? '';
    for (const entry of namedImports.split(',')) {
      const [imported, alias] = entry
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/);
      if (METRIC_TYPES.includes(imported)) names.add(alias ?? imported);
    }
  }

  for (const namespace of namespaces) {
    for (const type of METRIC_TYPES) names.add(`${namespace}.${type}`);
  }
  return names;
}

function matchingCallEnd(source, openIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length;
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

export function checkMetricRegistry(root) {
  const absoluteRoot = resolve(root);
  const packagesDir = resolve(absoluteRoot, 'packages');
  const files = walk(packagesDir).filter((file) => {
    const path = relative(packagesDir, file).split('\\').join('/');
    return path.includes('/src/') && SOURCE_EXT.test(file);
  });
  const violations = [];

  for (const file of files.sort()) {
    const source = stripComments(readFileSync(file, 'utf8'));
    const constructorNames = [...importedMetricConstructors(source)]
      .sort((left, right) => right.length - left.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const constructorPattern = new RegExp(
      `^(?:export\\s+)?(?:const|let|var)\\s+[\\w$]+\\s*=\\s*new\\s+(${constructorNames.join('|')})\\s*\\(`,
      'gm',
    );

    for (const match of source.matchAll(constructorPattern)) {
      const openIndex = source.indexOf('(', match.index);
      const endIndex = matchingCallEnd(source, openIndex);
      const options = source.slice(openIndex + 1, endIndex);
      if (/\bregisters\s*:/.test(options)) continue;
      violations.push({
        rule: 'module-scope-metric-registry',
        file: relative(absoluteRoot, file).split('\\').join('/'),
        line: lineAt(source, match.index),
        evidence: `new ${match[1]}(...)`,
        message:
          'Module-scope prom-client metrics must declare registers explicitly',
      });
    }
  }

  return { filesScanned: files.length, violations };
}

function main() {
  const result = checkMetricRegistry(resolve('.'));
  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      process.stderr.write(
        `${violation.file}:${violation.line} ${violation.message} (${violation.evidence})\n`,
      );
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Metric registry guard passed (${result.filesScanned} package source files scanned).\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main();
}
