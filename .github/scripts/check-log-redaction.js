#!/usr/bin/env node
/**
 * #610 log-redaction guard: fails when a logger call interpolates a raw
 * external-id variable without an id-specific masking helper. Checks each
 * interpolation separately; a whole first argument wrapped in redactLogLine
 * is also accepted. String-concatenation logging is not covered —
 * template literals are the repo convention.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ID_VARS =
  'psid|externalUserId|discordUserId|zaloUserId|externalId|discordId|zaloId';
const ID_VARIABLE = new RegExp(`\\b(?:${ID_VARS})\\b`);
const ID_MASK_HELPER =
  /^(?:maskExternalId|maskEventId|maskExternalIdInText)\s*\(/;
const LOG_CALL =
  /\.(?:log|warn|error|debug|verbose|fatal)\(\s*(?:redactLogLine\(\s*)?`/;
const WHOLE_LINE_REDACTION =
  /\.(?:log|warn|error|debug|verbose|fatal)\(\s*redactLogLine\(\s*`/;

function listSourceFiles() {
  const out = execSync('git ls-files -- "*.ts"', {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (file) =>
        file.endsWith('.ts') &&
        !file.endsWith('.spec.ts') &&
        /^(apps\/[^/]+\/src\/|packages\/[^/]+\/src\/)/.test(file),
    )
    .map((file) => path.join(ROOT, file));
}

/** Return the expressions inside `${...}` in a logger template literal. */
function templateExpressions(statement) {
  const expressions = [];
  let cursor = 0;

  while ((cursor = statement.indexOf('${', cursor)) !== -1) {
    const start = cursor + 2;
    let braceDepth = 0;
    let quote;
    let escaped = false;
    let end = -1;

    for (let i = start; i < statement.length; i++) {
      const char = statement[i];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === quote) {
          quote = undefined;
        }
        continue;
      }

      if (char === "'" || char === '"' || char === '`') {
        quote = char;
      } else if (char === '{') {
        braceDepth++;
      } else if (char === '}') {
        if (braceDepth === 0) {
          end = i;
          break;
        }
        braceDepth--;
      }
    }

    if (end === -1) break;
    expressions.push(statement.slice(start, end));
    cursor = end + 1;
  }

  return expressions;
}

function isDirectIdMaskCall(expression) {
  const match = ID_MASK_HELPER.exec(expression);
  if (!match) return false;

  let depth = 0;
  let quote;
  let escaped = false;
  const openParen = match[0].lastIndexOf('(');

  for (let i = openParen; i < expression.length; i++) {
    const char = expression[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0) return expression.slice(i + 1).trim() === '';
    }
  }

  return false;
}

function hasUnsafeExternalIdInterpolation(statement) {
  if (WHOLE_LINE_REDACTION.test(statement)) return false;

  return templateExpressions(statement).some(
    (expression) =>
      ID_VARIABLE.test(expression) && !isDirectIdMaskCall(expression),
  );
}

/**
 * Collect template-literal logger statements: the call line plus
 * continuation lines until the backticks balance.
 */
function* statements(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!LOG_CALL.test(lines[i])) continue;
    let statement = lines[i];
    let j = i;
    while (
      (statement.match(/`/g) || []).length % 2 === 1 &&
      j + 1 < lines.length
    ) {
      j++;
      statement += `\n${lines[j]}`;
    }
    yield { start: i + 1, statement };
    i = j;
  }
}

function main() {
  const violations = [];
  for (const file of listSourceFiles()) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (const { start, statement } of statements(lines)) {
      if (!hasUnsafeExternalIdInterpolation(statement)) continue;
      violations.push(
        `${path.relative(ROOT, file)}:${start}: ${statement.split('\n')[0].trim()}`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(
      `#610 log-redaction guard: ${violations.length} logger call(s) interpolate raw external ids without an id-specific mask:\n` +
        violations.map((v) => `  ${v}`).join('\n') +
        `\nWrap each id expression with maskExternalId(...) (see AGENTS.md "Log redaction").`,
    );
    process.exit(1);
  }
  console.log(
    'log-redaction guard: no raw external-id interpolation in logger calls',
  );
}

module.exports = {
  hasUnsafeExternalIdInterpolation,
  statements,
  templateExpressions,
};

if (require.main === module) main();
