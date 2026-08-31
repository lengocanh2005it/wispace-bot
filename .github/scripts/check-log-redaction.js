#!/usr/bin/env node
/**
 * #610 log-redaction guard: fails when a logger call interpolates a raw
 * external-id variable (template literal) without a masking helper in the
 * same statement. Handles multi-line logger calls by accumulating until the
 * template literal closes. String-concatenation logging is not covered —
 * template literals are the repo convention.
 */
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ID_VARS =
  'psid|externalUserId|discordUserId|zaloUserId|externalId|discordId|zaloId';
const MASK_HELPERS =
  /maskExternalId|maskEventId|maskExternalIdInText|redactLogLine|errorMessage|sanitizeLogValue|sanitizeErrorStack/;
const LOG_CALL = /\.(log|warn|error|debug|verbose|fatal)\(\s*`/;

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

/**
 * Collect template-literal logger statements: the call line plus
 * continuation lines until the backticks balance.
 */
function* statements(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!LOG_CALL.test(lines[i])) continue;
    let statement = lines[i];
    let j = i;
    while ((statement.match(/`/g) || []).length % 2 === 1 && j + 1 < lines.length) {
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
      content = require('fs').readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (const { start, statement } of statements(lines)) {
      const idVar = new RegExp(`\\$\\{[^}]*\\b(?:${ID_VARS})\\b`).exec(
        statement,
      );
      if (!idVar) continue;
      if (MASK_HELPERS.test(statement)) continue;
      violations.push(
        `${path.relative(ROOT, file)}:${start}: ${statement.split('\n')[0].trim()}`,
      );
    }
  }

  if (violations.length > 0) {
    console.error(
      `#610 log-redaction guard: ${violations.length} logger call(s) interpolate raw external ids without a mask helper:\n` +
        violations.map((v) => `  ${v}`).join('\n') +
        `\nWrap with maskExternalId(...) (see AGENTS.md "Log redaction").`,
    );
    process.exit(1);
  }
  console.log(
    'log-redaction guard: no raw external-id interpolation in logger calls',
  );
}

main();
