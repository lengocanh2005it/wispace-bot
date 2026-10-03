#!/usr/bin/env node
/**
 * Shared packages must not register Prometheus metrics in the process-wide
 * default registry. Module-scope metrics need an explicit per-app registry.
 */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const PACKAGES_ROOT = path.join(ROOT, 'packages');
const METRIC_CLASSES = new Set(['Counter', 'Gauge', 'Histogram']);
const FUNCTION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function isFunctionLike(node) {
  return FUNCTION_KINDS.has(node.kind);
}

function isModuleScope(node) {
  for (let current = node.parent; current && !ts.isSourceFile(current);) {
    if (isFunctionLike(current) || ts.isClassLike(current)) return false;
    current = current.parent;
  }
  return true;
}

function metricClassName(
  expression,
  metricAliases,
  namespaceImports,
  defaultImports,
) {
  if (ts.isIdentifier(expression)) {
    return metricAliases.get(expression.text) ?? expression.text;
  }
  const namespaceTarget =
    (ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression)) &&
    ts.isIdentifier(expression.expression) &&
    (namespaceImports.has(expression.expression.text) ||
      defaultImports.has(expression.expression.text))
      ? expression
      : undefined;
  if (namespaceTarget) {
    // `prom.Counter` and `prom['Counter']` are the same access.
    return ts.isPropertyAccessExpression(namespaceTarget)
      ? namespaceTarget.name.text
      : ts.isStringLiteral(namespaceTarget.argumentExpression)
        ? namespaceTarget.argumentExpression.text
        : undefined;
  }
  return undefined;
}

function hasRegistersOption(argument) {
  if (!argument || !ts.isObjectLiteralExpression(argument)) return false;
  return argument.properties.some(
    (property) =>
      (ts.isPropertyAssignment(property) ||
        ts.isShorthandPropertyAssignment(property)) &&
      propertyNameText(property.name) === 'registers',
  );
}

function lineOf(sourceFile, node) {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

function analyzeSource(source, fileName = 'fixture.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations = [];
  const namespaceImports = new Set();
  const defaultImports = new Set();
  const metricAliases = new Map();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'prom-client' ||
      !statement.importClause
    ) {
      continue;
    }

    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const importedName = (element.propertyName ?? element.name).text;
        if (importedName === 'register') {
          violations.push({
            file: fileName,
            line: lineOf(sourceFile, element),
            message:
              'imports prom-client register, the process-wide default registry',
          });
        }
        if (METRIC_CLASSES.has(importedName)) {
          metricAliases.set(element.name.text, importedName);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      namespaceImports.add(bindings.name.text);
    }

    if (statement.importClause.name) {
      defaultImports.add(statement.importClause.name.text);
    }
  }

  function visit(node) {
    const isDefaultRegistryAccess =
      (ts.isPropertyAccessExpression(node) &&
        node.name.text === 'register' &&
        ts.isIdentifier(node.expression) &&
        (namespaceImports.has(node.expression.text) ||
          defaultImports.has(node.expression.text))) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === 'register' &&
        ts.isIdentifier(node.expression) &&
        (namespaceImports.has(node.expression.text) ||
          defaultImports.has(node.expression.text)));
    if (isDefaultRegistryAccess) {
      violations.push({
        file: fileName,
        line: lineOf(sourceFile, node),
        message: 'uses prom-client register, the process-wide default registry',
      });
    }

    const metricName = ts.isNewExpression(node)
      ? metricClassName(
          node.expression,
          metricAliases,
          namespaceImports,
          defaultImports,
        )
      : undefined;
    if (
      ts.isNewExpression(node) &&
      METRIC_CLASSES.has(metricName) &&
      isModuleScope(node) &&
      !hasRegistersOption(node.arguments?.[0])
    ) {
      violations.push({
        file: fileName,
        line: lineOf(sourceFile, node),
        message: `module-scope ${metricName} must specify a per-app registers option`,
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function walkTypeScriptFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkTypeScriptFiles(file);
    if (
      entry.isFile() &&
      file.endsWith('.ts') &&
      !file.endsWith('.d.ts') &&
      !file.endsWith('.spec.ts') &&
      !file.endsWith('.test.ts')
    ) {
      return [file];
    }
    return [];
  });
}

function main() {
  const files = fs
    .readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      walkTypeScriptFiles(path.join(PACKAGES_ROOT, entry.name, 'src')),
    );
  const violations = files.flatMap((file) =>
    analyzeSource(fs.readFileSync(file, 'utf8'), path.relative(ROOT, file)),
  );

  if (violations.length > 0) {
    console.error(
      `Metric registry guard: ${violations.length} violation(s):\n` +
        violations
          .map(
            (violation) =>
              `  ${violation.file}:${violation.line}: ${violation.message}`,
          )
          .join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  console.log('Metric registry guard: shared packages use per-app registries');
}

module.exports = { analyzeSource, hasRegistersOption, isModuleScope };

if (require.main === module) main();
