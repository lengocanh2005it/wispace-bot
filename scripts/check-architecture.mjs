import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import ts from 'typescript';

const FRAMEWORK_IMPORT =
  /^(?:@nestjs(?:\/|$)|@nestjs\/typeorm$|typeorm$|express$)/;
const CONCRETE_OUTER_PACKAGE =
  /^(?:@wispace\/(?:database|wispace-client|chat-agent|student-report|chat-metering|study-reminder-shared|scheduler-core|ops-health|cleanup-cron|bot-common)(?:\/|$)|typeorm$|@nestjs\/typeorm$|ioredis$|redis$|undici$|axios$|openai$|discord\.js$|@discordjs(?:\/|$)|node:(?:http|https|net|tls)$)/;
const HARD_OUTER_PACKAGE =
  /^(?:@wispace\/database(?:\/|$)|typeorm$|@nestjs\/typeorm$|ioredis$|redis$|undici$|axios$|openai$|discord\.js$|@discordjs(?:\/|$)|node:(?:http|https|net|tls)$)/;
const MIXED_PACKAGE =
  /^@wispace\/(?:wispace-client|chat-agent|student-report|chat-metering|study-reminder-shared|scheduler-core|ops-health|cleanup-cron|bot-common)(?:\/|$)/;
const CONCRETE_OUTER_SYMBOL =
  /(?:Entity|Repository|Service|Controller|Gateway|Adapter|ApiClient|Client|RedisStore)$/;
const APP_IMPORT = /^(?:@messenger\/|@discord\/|@zalo\/)/;
// #1126: these packages publish only explicit subpaths; a bare root specifier
// is not a compatibility facade and must not resolve.
const ROOT_SPECIFIER = /^@wispace\/(account-link-core|chat-metering|cleanup-cron|llm-agent|ops-health|reschedule-confirm|scheduler-core|student-report|study-reminder-shared|wispace-client)$/;
const DATABASE_FORBIDDEN_DEPENDENCIES = [
  '@wispace/reschedule-confirm',
  '@wispace/scheduler-core',
  '@wispace/bot-metrics',
];
const DATABASE_PACKAGE = '@wispace/database';
const ALLOWED_DATABASE_TOOLING_FILES = new Set([
  'scripts/database-bootstrap-smoke.mjs',
  'scripts/database-persistence-semantics-smoke.mjs',
  'scripts/database-privacy-smoke.mjs',
  'scripts/study-reminder-delivery-smoke.mjs',
  'scripts/privacy-erasure-drill.mjs',
]);
const REQUIRED_SCAN_TARGETS = [
  'apps',
  'packages',
  'packages/database/src',
  'scripts',
];
const OUTER_PATH =
  /(?:^|\/)(?:infrastructure|persistence|presentation|adapters|database)(?:\/|$)/;
const DOMAIN_OUTER_PATH =
  /(?:^|\/)(?:application|infrastructure|persistence|presentation|adapters|database)(?:\/|$)/;
const CORE_OUTER_PATH =
  /(?:^|\/)(?:infrastructure|persistence|presentation|adapters|database|entities)(?:\/|$)/;

/**
 * These files are adapters by design. They are intentionally outside the core
 * scopes below; widening this list requires a named issue and owner.
 */
export const FRAMEWORK_BOUND_ADAPTERS = [
  'packages/llm-agent/src/utils/privacy-state.service.ts',
  'packages/student-report/src/platform-student-report.service.ts',
];

const CORE_RULES = [
  {
    rule: 'contracts-core-no-imports',
    globs: ['packages/contracts/src/**'],
    forbidden: () => true,
    message: 'the shared contracts core must remain dependency-free',
  },
  coreEntryPointRule('llm-agent', ['packages/llm-agent/src/core/**']),
  coreEntryPointRule('wispace-client', ['packages/wispace-client/src/core/**']),
  coreEntryPointRule('student-report', ['packages/student-report/src/core/**']),
  coreEntryPointRule('chat-metering', ['packages/chat-metering/src/core/**']),
  coreEntryPointRule('scheduler-core', ['packages/scheduler-core/src/core/**']),
  coreEntryPointRule('study-reminder-shared', [
    'packages/study-reminder-shared/src/core/**',
  ]),
  coreEntryPointRule('ops-health', ['packages/ops-health/src/core/**']),
  coreEntryPointRule('account-link-core', [
    'packages/account-link-core/src/core/**',
  ]),
  {
    rule: 'domain-no-framework',
    globs: ['apps/*/src/modules/*/domain/**'],
    forbidden: (specifier, symbols) =>
      FRAMEWORK_IMPORT.test(specifier) ||
      HARD_OUTER_PACKAGE.test(specifier) ||
      DOMAIN_OUTER_PATH.test(specifier) ||
      isConcreteMixedImport(specifier, symbols),
    message: 'domain must not import framework or infrastructure details',
  },
  {
    rule: 'application-no-outer',
    globs: ['apps/*/src/modules/*/application/**'],
    excludes: ['apps/*/src/modules/*/application/ports/**'],
    forbidden: (specifier, symbols) =>
      HARD_OUTER_PACKAGE.test(specifier) ||
      OUTER_PATH.test(specifier) ||
      isConcreteMixedImport(specifier, symbols),
    message:
      'application code must depend on ports, not concrete infrastructure details',
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
  frameworkFreePackageRule('account-link-core', [
    'packages/account-link-core/src/core/**',
  ]),
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
    'packages/ops-health/src/data-quality.service.ts',
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

function coreEntryPointRule(name, globs) {
  return {
    rule: `${name}-entrypoint-no-outer`,
    globs,
    forbidden: (specifier) =>
      FRAMEWORK_IMPORT.test(specifier) ||
      CONCRETE_OUTER_PACKAGE.test(specifier) ||
      CORE_OUTER_PATH.test(specifier),
    message: `${name} core entrypoints must not import framework, infrastructure, or adapter details`,
  };
}

function isConcreteMixedImport(specifier, symbols) {
  return (
    MIXED_PACKAGE.test(specifier) &&
    (symbols ?? []).some((symbol) => CONCRETE_OUTER_SYMBOL.test(symbol))
  );
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

function databaseTypeScriptFiles(rootDir) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') {
          visit(fullPath);
        }
        continue;
      }
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(fullPath);
      }
    }
  };

  const sourceRoot = path.join(rootDir, 'packages', 'database', 'src');
  if (existsSync(sourceRoot)) visit(sourceRoot);
  return files;
}

function importedModules(fileName, sourceText) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const imports = [];
  const add = (node, moduleSpecifier, symbols) => {
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    imports.push({
      imported: moduleSpecifier.text,
      line: position.line + 1,
      symbols: symbols ?? importedSymbols(node),
    });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node, node.moduleSpecifier);
      return;
    }
    // `import('@wispace/pkg').Type` in a type position resolves like any other
    // import, so the entrypoint rule has to see it.
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      add(node, node.argument.literal);
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
    if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ((ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === 'module' &&
            node.expression.name.text === 'require') ||
            (ts.isIdentifier(node.expression.expression) &&
              node.expression.expression.text === 'require' &&
              node.expression.name.text === 'resolve'))))
    ) {
      add(node, node.arguments[0], ['require']);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return imports;
}

function isDatabaseForbiddenDependency(specifier) {
  return DATABASE_FORBIDDEN_DEPENDENCIES.some(
    (dependency) =>
      specifier === dependency || specifier.startsWith(`${dependency}/`),
  );
}

function databaseDependencyViolation(relativePath, imported) {
  if (
    !relativePath.startsWith('packages/database/') ||
    !isDatabaseForbiddenDependency(imported.imported)
  ) {
    return undefined;
  }
  return {
    rule: 'database-no-domain-dependency',
    package: 'packages/database',
    file: relativePath,
    line: imported.line,
    imported: imported.imported,
    symbols: imported.symbols,
    message:
      'the database package must not import or depend on domain policy packages',
  };
}

function databaseManifestViolation(rootDir) {
  const manifestPath = path.join(
    rootDir,
    'packages',
    'database',
    'package.json',
  );
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const dependencyGroups = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ];
  const names = new Set(
    dependencyGroups.flatMap((group) =>
      group && typeof group === 'object' ? Object.keys(group) : [],
    ),
  );
  return DATABASE_FORBIDDEN_DEPENDENCIES.filter((dependency) =>
    names.has(dependency),
  ).map((dependency) => ({
    rule: 'database-no-domain-dependency',
    package: 'packages/database',
    file: 'packages/database/package.json',
    line: 0,
    imported: dependency,
    symbols: ['manifest'],
    message:
      'the database package must not import or depend on domain policy packages',
  }));
}

function databaseLockfileViolation(rootDir) {
  const lockfilePath = path.join(rootDir, 'package-lock.json');
  if (!existsSync(lockfilePath)) return [];
  const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
  const databasePackage = lockfile.packages?.['packages/database'];
  if (!databasePackage) return [];
  const dependencyGroups = [
    databasePackage.dependencies,
    databasePackage.devDependencies,
    databasePackage.peerDependencies,
    databasePackage.optionalDependencies,
  ];
  const names = new Set(
    dependencyGroups.flatMap((group) =>
      group && typeof group === 'object' ? Object.keys(group) : [],
    ),
  );
  return DATABASE_FORBIDDEN_DEPENDENCIES.filter((dependency) =>
    names.has(dependency),
  ).map((dependency) => ({
    rule: 'database-no-domain-dependency',
    package: 'packages/database',
    file: 'package-lock.json',
    line: 0,
    imported: dependency,
    symbols: ['lockfile'],
    message:
      'the database package must not import or depend on domain policy packages',
  }));
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

function isExcluded(relativePath, rule) {
  return (
    matchesAnyGlob(relativePath, FRAMEWORK_BOUND_ADAPTERS) ||
    (rule.excludes ?? []).some((glob) => matchesGlob(relativePath, glob))
  );
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

function rootEntrypointViolation(relativePath, imported) {
  if (!ROOT_SPECIFIER.test(imported.imported)) return undefined;
  return {
    rule: 'no-root-package-entrypoint',
    package: ownerOf(relativePath),
    file: relativePath,
    line: imported.line,
    imported: imported.imported,
    symbols: imported.symbols,
    message:
      'shared packages publish explicit /core and /adapters subpaths; import the narrowest subpath instead of the package root',
  };
}

const MESSENGER_FEATURE_ROOT = 'apps/messenger-bot/src/modules/messenger/';
const STUDY_REMINDER_FEATURE_ROOT =
  'apps/messenger-bot/src/modules/study-reminder/';

function featureForPath(relativePath) {
  if (relativePath.startsWith(MESSENGER_FEATURE_ROOT)) return 'messenger';
  if (relativePath.startsWith(STUDY_REMINDER_FEATURE_ROOT)) {
    return 'study-reminder';
  }
  return undefined;
}

function featureForImport(relativePath, specifier) {
  if (specifier.startsWith('@messenger/modules/messenger/')) {
    return 'messenger';
  }
  if (specifier.startsWith('@messenger/modules/study-reminder/')) {
    return 'study-reminder';
  }
  if (!specifier.startsWith('.')) return undefined;

  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(relativePath), specifier),
  );
  return featureForPath(resolved);
}

function isCompositionRoot(relativePath) {
  return relativePath.endsWith('.module.ts');
}

function isStudyReminderPortImport(specifier) {
  return (
    specifier.endsWith('/study-reminder-operations.port') ||
    specifier.endsWith('/study-reminder-sync.port')
  );
}

function featureBoundaryViolation(relativePath, imported) {
  const sourceFeature = featureForPath(relativePath);
  const targetFeature = featureForImport(relativePath, imported.imported);
  if (!sourceFeature || !targetFeature || sourceFeature === targetFeature) {
    return undefined;
  }

  if (
    sourceFeature === 'messenger' &&
    (isCompositionRoot(relativePath) ||
      isStudyReminderPortImport(imported.imported))
  ) {
    return undefined;
  }
  if (sourceFeature === 'study-reminder' && isCompositionRoot(relativePath)) {
    return undefined;
  }

  return {
    rule:
      sourceFeature === 'messenger'
        ? 'messenger-study-reminder-boundary'
        : 'study-reminder-messenger-boundary',
    package: ownerOf(relativePath),
    file: relativePath,
    line: imported.line,
    imported: imported.imported,
    symbols: imported.symbols,
    message:
      sourceFeature === 'messenger'
        ? 'messenger feature code must consume study-reminder ports, not concrete feature details'
        : 'study-reminder feature code must not depend on messenger feature details',
  };
}

function deliveryCycleViolation(relativePath, imported) {
  const outboundFile =
    'apps/messenger-bot/src/modules/messenger/application/services/messenger-outbound.service.ts';
  const chatDeliveryFile =
    'apps/messenger-bot/src/modules/messenger/application/messages/chat-delivery.messages.ts';
  const importsChatDelivery =
    imported.imported === '../messages/chat-delivery.messages' ||
    imported.imported.endsWith(
      '/messenger/application/messages/chat-delivery.messages',
    );
  const importsOutbound =
    imported.imported === '../services/messenger-outbound.service' ||
    imported.imported.endsWith(
      '/messenger/application/services/messenger-outbound.service',
    );

  if (
    !(
      (relativePath === outboundFile && importsChatDelivery) ||
      (relativePath === chatDeliveryFile && importsOutbound)
    )
  ) {
    return undefined;
  }

  return {
    rule: 'messenger-delivery-cycle',
    package: ownerOf(relativePath),
    file: relativePath,
    line: imported.line,
    imported: imported.imported,
    symbols: imported.symbols,
    message:
      'messenger outbound transport must not import chat-delivery message formatting',
  };
}

function ownerOf(relativePath) {
  return relativePath.split('/').slice(0, 2).join('/');
}

function toolingFiles(rootDir) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (
        /\.[cm]?js$/.test(entry.name) &&
        !/\.(?:test|spec)\.[cm]?js$/.test(entry.name)
      ) {
        files.push(fullPath);
      }
    }
  };
  visit(path.join(rootDir, 'scripts'));
  const appsRoot = path.join(rootDir, 'apps');
  for (const app of readdirSync(appsRoot, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const scriptsPath = path.join(appsRoot, app.name, 'scripts');
    if (existsSync(scriptsPath)) visit(scriptsPath);
  }
  return files;
}

function isTestSource(relativePath) {
  return (
    /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(relativePath) ||
    /\.(?:spec|test)\.[cm]?tsx?$/.test(relativePath)
  );
}

function isDatabaseSpecifier(specifier) {
  return specifier === DATABASE_PACKAGE ||
    specifier.startsWith(`${DATABASE_PACKAGE}/`);
}

function databaseRoleViolation(relativePath, imported, sourceKind) {
  if (!isDatabaseSpecifier(imported.imported) || isTestSource(relativePath)) {
    return undefined;
  }

  if (sourceKind === 'tooling') {
    if (ALLOWED_DATABASE_TOOLING_FILES.has(relativePath)) return undefined;
    return {
      rule: 'database-tooling-role',
      package: ownerOf(relativePath),
      file: relativePath,
      line: imported.line,
      imported: imported.imported,
      symbols: imported.symbols,
      message:
        'tooling may import @wispace/database only from the five approved database smoke and drill scripts',
    };
  }

  if (relativePath.startsWith('packages/')) {
    const packageName = relativePath.split('/')[1];
    if (
      packageName === 'database' ||
      relativePath.startsWith(`packages/${packageName}/src/adapters/`) ||
      relativePath.startsWith('packages/contracts/src/')
    ) {
      return undefined;
    }
    return {
      rule: 'shared-package-database-adapter-only',
      package: ownerOf(relativePath),
      file: relativePath,
      line: imported.line,
      imported: imported.imported,
      symbols: imported.symbols,
      message:
        'shared packages may import @wispace/database only from their canonical src/adapters subtree',
    };
  }

  if (relativePath.startsWith('apps/')) {
    if (
      /^apps\/[^/]+\/src\/(?:infrastructure|persistence|adapters|database)\//.test(
        relativePath,
      ) ||
      /^apps\/[^/]+\/src\/modules\/[^/]+\/(?:infrastructure|persistence|adapters|database)\//.test(
        relativePath,
      ) ||
      /\/src\/.*\.module\.ts$/.test(relativePath) ||
      /\/src\/(?:main|app\.module)\.ts$/.test(relativePath) ||
      /\/src\/modules\/[^/]+\/(?:domain|application)\//.test(relativePath)
    ) {
      return undefined;
    }
    return {
      rule: 'app-database-composition-only',
      package: ownerOf(relativePath),
      file: relativePath,
      line: imported.line,
      imported: imported.imported,
      symbols: imported.symbols,
      message:
        'app database dependencies belong in infrastructure adapters or composition roots, not presentation or feature services',
    };
  }

  return undefined;
}

function scanScopeViolations(rootDir) {
  const missing = REQUIRED_SCAN_TARGETS.filter(
    (target) => !existsSync(path.join(rootDir, target)),
  );
  return missing.map((target) => ({
    rule: 'architecture-scan-scope',
    package: 'repository',
    file: target,
    line: 0,
    imported: target,
    symbols: [],
    message: 'required architecture scan target is missing',
  }));
}

function scriptImportViolations(rootDir, files) {
  const violations = [];
  for (const file of files) {
    const relativePath = path
      .relative(rootDir, file)
      .replaceAll(path.sep, '/');
    const source = readFileSync(file, 'utf8');
    for (const imported of importedModules(file, source)) {
      const entrypointViolation = rootEntrypointViolation(
        relativePath,
        imported,
      );
      if (entrypointViolation) violations.push(entrypointViolation);
      const dbViolation = databaseRoleViolation(
        relativePath,
        imported,
        'tooling',
      );
      if (dbViolation) violations.push(dbViolation);
    }
  }
  return violations;
}

export function checkArchitecture(rootDir) {
  const absoluteRoot = path.resolve(rootDir);
  const violations = scanScopeViolations(absoluteRoot);
  if (violations.length > 0) return { scannedFiles: 0, violations };

  const files = sourceFiles(absoluteRoot);
  if (files.length === 0) {
    return {
      scannedFiles: 0,
      violations: [
        {
          rule: 'architecture-scan-empty',
          package: 'repository',
          file: 'apps,packages',
          line: 0,
          imported: '',
          symbols: [],
          message: 'architecture scan found no production TypeScript files',
        },
      ],
    };
  }

  const scripts = toolingFiles(absoluteRoot);
  violations.push(...scriptImportViolations(absoluteRoot, scripts));
  let scannedFiles = 0;

  for (const file of files) {
    scannedFiles += 1;
    const relativePath = path
      .relative(absoluteRoot, file)
      .replaceAll(path.sep, '/');
    const source = readFileSync(file, 'utf8');
    const imports = importedModules(file, source);

    for (const imported of imports) {
      const dbViolation = databaseRoleViolation(
        relativePath,
        imported,
        'source',
      );
      if (dbViolation) violations.push(dbViolation);

      const boundaryViolation = featureBoundaryViolation(
        relativePath,
        imported,
      );
      if (boundaryViolation) violations.push(boundaryViolation);

      const cycleViolation = deliveryCycleViolation(relativePath, imported);
      if (cycleViolation) violations.push(cycleViolation);

      const packageViolation = packageImportViolation(relativePath, imported);
      if (packageViolation) {
        packageViolation.line = imported.line;
        violations.push(packageViolation);
      }

      const entrypointViolation = rootEntrypointViolation(
        relativePath,
        imported,
      );
      if (entrypointViolation) violations.push(entrypointViolation);

      for (const rule of CORE_RULES) {
        if (
          !matchesAnyGlob(relativePath, rule.globs) ||
          isExcluded(relativePath, rule)
        ) {
          continue;
        }
        if (rule.allow?.(relativePath, imported)) continue;
        if (!rule.forbidden(imported.imported, imported.symbols)) continue;
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

  for (const file of databaseTypeScriptFiles(absoluteRoot)) {
    const relativePath = path
      .relative(absoluteRoot, file)
      .replaceAll(path.sep, '/');
    const source = readFileSync(file, 'utf8');
    for (const imported of importedModules(file, source)) {
      const violation = databaseDependencyViolation(relativePath, imported);
      if (violation) violations.push(violation);
    }
  }
  violations.push(...databaseManifestViolation(absoluteRoot));
  violations.push(...databaseLockfileViolation(absoluteRoot));

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
