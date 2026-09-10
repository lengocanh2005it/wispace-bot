import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import ts from 'typescript';

const FRAMEWORK_IMPORT =
  /^(?:@nestjs(?:\/|$)|@nestjs\/typeorm$|typeorm$|express$)/;
const CONCRETE_OUTER_PACKAGE =
  /^(?:@wispace\/(?:database|wispace-client|chat-agent|student-report|chat-metering|study-reminder-shared|scheduler-core|ops-health|cleanup-cron|bot-common)(?:\/|$)|typeorm$|@nestjs\/typeorm$|ioredis$|redis$|undici$|axios$|openai$)/;
const DOMAIN_OUTER_PACKAGE =
  /^(?:@wispace\/database(?:\/|$)|typeorm$|@nestjs\/typeorm$|ioredis$|redis$|undici$|axios$|openai$)/;
const APP_IMPORT = /^(?:@messenger\/|@discord\/|@zalo\/)/;
const OUTER_PATH =
  /(?:^|\/)(?:infrastructure|persistence|presentation|adapters|database)(?:\/|$)/;

/**
 * These files are adapters by design. They are intentionally outside the core
 * scopes below; widening this list requires a named issue and owner.
 */
export const FRAMEWORK_BOUND_ADAPTERS = [
  'packages/llm-agent/src/utils/privacy-state.service.ts',
  'packages/student-report/src/platform-student-report.service.ts',
  'packages/wispace-client/src/wispace-providers.ts',
  'packages/wispace-client/src/config/**',
  'packages/wispace-client/src/clients/*service.ts',
  'packages/wispace-client/src/cache/redis-wispace-cache.store.ts',
  'packages/chat-agent/src/**',
  'packages/chat-metering/src/chat-metering.module.ts',
  'packages/chat-metering/src/**/platform-*.ts',
  'packages/chat-metering/src/**/*.repository.ts',
  'packages/chat-metering/src/entities/**',
  'packages/learner-profile/src/typeorm-learner-profile.store.ts',
  'packages/learner-profile/src/recorder.ts',
  'packages/learner-profile/src/suffix.ts',
  'packages/scheduler-core/src/services/**',
  'packages/study-reminder-shared/src/services/**',
  'packages/study-reminder-shared/src/infrastructure/**',
  'packages/study-reminder-shared/src/entities/**',
  'packages/ops-health/src/ops-health.service.ts',
  'packages/ops-health/src/typeorm-*.ts',
  'packages/ops-health/src/data-quality.service.ts',
  'packages/ops-health/src/cron-heartbeat-registry.ts',
  'packages/cleanup-cron/src/**',
];

const CORE_RULES = [
  {
    rule: 'contracts-core-no-imports',
    globs: ['packages/contracts/src/**'],
    forbidden: () => true,
    message: 'the shared contracts core must remain dependency-free',
  },
  {
    rule: 'domain-no-framework',
    globs: ['apps/*/src/modules/*/domain/**'],
    forbidden: (specifier) =>
      FRAMEWORK_IMPORT.test(specifier) ||
      DOMAIN_OUTER_PACKAGE.test(specifier) ||
      OUTER_PATH.test(specifier),
    message: 'domain must not import framework or infrastructure details',
  },
  {
    rule: 'application-port-no-outer',
    globs: ['apps/*/src/modules/*/application/ports/**'],
    forbidden: (specifier) =>
      FRAMEWORK_IMPORT.test(specifier) ||
      CONCRETE_OUTER_PACKAGE.test(specifier) ||
      OUTER_PATH.test(specifier),
    message: 'application ports must depend on inner contracts, not adapters',
  },
  frameworkFreePackageRule('chat-history', ['packages/chat-history/src/**']),
  frameworkFreePackageRule('chat-queue-core', [
    'packages/chat-queue-core/src/**',
  ]),
  frameworkFreePackageRule('chat-pipeline', ['packages/chat-pipeline/src/**']),
  frameworkFreePackageRule('date-utils', ['packages/date-utils/src/**']),
  frameworkFreePackageRule('llm-agent', ['packages/llm-agent/src/**']),
  frameworkFreePackageRule('student-report', [
    'packages/student-report/src/**',
  ]),
  frameworkFreePackageRule('scheduler-core', [
    'packages/scheduler-core/src/ports/**',
    'packages/scheduler-core/src/types/**',
    'packages/scheduler-core/src/utils/**',
  ]),
  frameworkFreePackageRule('study-reminder-shared', [
    'packages/study-reminder-shared/src/ports/**',
    'packages/study-reminder-shared/src/types/**',
    'packages/study-reminder-shared/src/utils/**',
  ]),
  frameworkFreePackageRule('ops-health', [
    'packages/ops-health/src/types.ts',
    'packages/ops-health/src/data-quality.types.ts',
    'packages/ops-health/src/data-quality.evaluator.ts',
    'packages/ops-health/src/data-quality.config.ts',
  ]),
  frameworkFreePackageRule('wispace-client', [
    'packages/wispace-client/src/types/**',
    'packages/wispace-client/src/errors/**',
    'packages/wispace-client/src/utils/**',
    'packages/wispace-client/src/cache/wispace-data-cache.ts',
    'packages/wispace-client/src/cache/wispace-cache-policy.ts',
    'packages/wispace-client/src/cache/wispace-cache-shared-store.port.ts',
    'packages/wispace-client/src/clients/*.api.client.ts',
    'packages/wispace-client/src/clients/*-api.client.ts',
    'packages/wispace-client/src/clients/*-normalizer.ts',
    'packages/wispace-client/src/clients/wispace-client-types.ts',
  ]),
  frameworkFreePackageRule('chat-metering', [
    'packages/chat-metering/src/**/types.ts',
    'packages/chat-metering/src/chat-quota.types.ts',
    'packages/chat-metering/src/**/**-core.service.ts',
    'packages/chat-metering/src/llm-safety/redact-safety-text.ts',
    'packages/chat-metering/src/llm-usage/cost.utils.ts',
    'packages/chat-metering/src/chat-rate-limit/memory-burst-counter.ts',
  ]),
];

function frameworkFreePackageRule(name, globs) {
  return {
    rule: `${name}-core-no-framework`,
    globs,
    forbidden: (specifier) => FRAMEWORK_IMPORT.test(specifier),
    message: `${name} core must not import framework or ORM details`,
  };
}

function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function matchesGlob(relativePath, glob) {
  return globToRegExp(glob).test(relativePath);
}

function matchesAnyGlob(relativePath, globs) {
  return globs.some((glob) => matchesGlob(relativePath, glob));
}

function sourceFiles(rootDir) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist')
          visit(fullPath);
        continue;
      }
      if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.d.ts') &&
        !entry.name.endsWith('.spec.ts') &&
        !entry.name.endsWith('.test.ts')
      ) {
        files.push(fullPath);
      }
    }
  };

  for (const directory of ['apps', 'packages']) {
    const fullPath = path.join(rootDir, directory);
    if (existsSync(fullPath)) visit(fullPath);
  }
  return files;
}

function importedModules(fileName, sourceText) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports = [];
  const add = (node, moduleSpecifier) => {
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    imports.push({
      imported: moduleSpecifier.text,
      line: position.line + 1,
      symbols: importedSymbols(node),
    });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node, node.moduleSpecifier);
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node, node.moduleReference.expression);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      add(node, node.arguments[0]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return imports;
}

function importedSymbols(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return ['*'];
    const symbols = clause.name ? [clause.name.text] : [];
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      symbols.push(
        ...clause.namedBindings.elements.map((element) =>
          (element.propertyName ?? element.name).getText(),
        ),
      );
    } else if (
      clause.namedBindings &&
      ts.isNamespaceImport(clause.namedBindings)
    ) {
      symbols.push('*');
    }
    return symbols.length > 0 ? symbols : ['*'];
  }
  if (
    ts.isExportDeclaration(node) &&
    node.exportClause &&
    ts.isNamedExports(node.exportClause)
  ) {
    return node.exportClause.elements.map((element) =>
      (element.propertyName ?? element.name).getText(),
    );
  }
  if (ts.isImportEqualsDeclaration(node)) return [node.name.text];
  return ['*'];
}

function isExcluded(relativePath) {
  return matchesAnyGlob(relativePath, FRAMEWORK_BOUND_ADAPTERS);
}

function packageImportViolation(relativePath, imported) {
  if (!relativePath.startsWith('packages/')) return undefined;
  if (APP_IMPORT.test(imported.imported)) {
    return {
      rule: 'package-no-app-imports',
      package: ownerOf(relativePath),
      file: relativePath,
      line: 0,
      imported: imported.imported,
      symbols: imported.symbols,
      message: 'shared packages must not depend on an application',
    };
  }
  return undefined;
}

function ownerOf(relativePath) {
  return relativePath.split('/').slice(0, 2).join('/');
}

export function checkArchitecture(rootDir) {
  const absoluteRoot = path.resolve(rootDir);
  const violations = [];
  let scannedFiles = 0;

  for (const file of sourceFiles(absoluteRoot)) {
    scannedFiles += 1;
    const relativePath = path
      .relative(absoluteRoot, file)
      .replaceAll(path.sep, '/');
    const source = readFileSync(file, 'utf8');
    const imports = importedModules(file, source);

    for (const imported of imports) {
      const packageViolation = packageImportViolation(relativePath, imported);
      if (packageViolation) {
        packageViolation.line = imported.line;
        violations.push(packageViolation);
      }

      for (const rule of CORE_RULES) {
        if (
          !matchesAnyGlob(relativePath, rule.globs) ||
          isExcluded(relativePath)
        ) {
          continue;
        }
        if (!rule.forbidden(imported.imported)) continue;
        violations.push({
          rule: rule.rule,
          package: ownerOf(relativePath),
          file: relativePath,
          line: imported.line,
          imported: imported.imported,
          symbols: imported.symbols,
          message: rule.message,
        });
      }
    }
  }

  return { scannedFiles, violations };
}

export function formatViolation(violation) {
  return `${violation.file}:${violation.line} [${violation.rule}] ${violation.package}: ${violation.message} (import ${violation.symbols.join(', ')} from ${violation.imported})`;
}

function run() {
  const rootDir = path.resolve(
    process.argv[2] ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
  );
  const result = checkArchitecture(rootDir);
  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error(formatViolation(violation));
    }
    console.error(
      `architecture check failed: ${result.violations.length} violation(s)`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `ok: architecture boundaries passed (${result.scannedFiles} source files)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) run();
