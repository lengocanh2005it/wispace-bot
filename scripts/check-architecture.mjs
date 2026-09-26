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

// Ratchet baseline for existing application edges. #1088 owns emptying this
// set — its acceptance criterion is that it is empty — and #432 is the
// umbrella. New edges fail immediately: add a port, never an entry here.
const LEGACY_APPLICATION_IMPORTS = new Set([
  'apps/discord-bot/src/modules/account-link/application/services/discord-link-completion.service.ts|@wispace/database|PlatformLinkStateService',
  'apps/discord-bot/src/modules/account-link/application/services/discord-link-completion.service.ts|@wispace/wispace-client/adapters|WispaceTokenVerifyService',
  'apps/discord-bot/src/modules/account-link/application/services/discord-link-reconcile-cron.service.ts|@wispace/bot-common/locks|ADVISORY_LOCKS,PgAdvisoryLockService',
  'apps/discord-bot/src/modules/account-link/application/services/discord-link-reconcile-cron.service.ts|@wispace/database|PlatformLinkStateService',
  'apps/discord-bot/src/modules/account-link/application/services/discord-link-reconcile-cron.service.ts|@wispace/wispace-client/core|WispaceLinkStatusClient',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-consent.service.ts|@wispace/database|NotificationPreferenceService',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-menu.service.ts|@wispace/wispace-client/adapters|WispaceCalendarService,WispaceGoalsService',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-outbound.service.ts|@wispace/database|DeliveryLogService,PlatformDeadLetterService',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-outbound.service.ts|discord.js|ActionRowBuilder,ButtonBuilder,ButtonStyle,Client,TextChannel',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-outbound.service.ts|discord.js|MessageCreateOptions',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-platform-connectivity.service.ts|discord.js|Client',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-report-cron.service.ts|@wispace/database|CanonicalPlatformService,WebActivityService',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-report-cron.service.ts|@wispace/scheduler-core/adapters|ReportCronLeaderService,ReportCronLockService,ReportScheduleService',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-report-orchestration.service.ts|@wispace/scheduler-core/adapters|ClassifiedError',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-report-orchestration.service.ts|@wispace/scheduler-core/adapters|ReportOrchestrationService',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-report-orchestration.service.ts|@wispace/student-report/adapters|PlatformStudentReportService',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-report-retry-dispatch.service.ts|@wispace/bot-common/locks|PgAdvisoryLockService,ADVISORY_LOCKS',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-report-retry-dispatch.service.ts|@wispace/scheduler-core/adapters|ReportCronLeaderService',
  'apps/discord-bot/src/modules/discord-chat/application/utils/discord-outbound-guard.ts|discord.js|MessageMentionOptions',
  'apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-idempotency-cleanup-cron.service.ts|@nestjs/typeorm|InjectRepository',
  'apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-idempotency-cleanup-cron.service.ts|@wispace/chat-metering/adapters|ChatIdempotencyEntity,ChatToolDailyUsageEntity',
  'apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-idempotency-cleanup-cron.service.ts|@wispace/cleanup-cron/adapters|CleanupCronService',
  'apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-idempotency-cleanup-cron.service.ts|typeorm|Repository',
  'apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-quota-consistency-cron.service.ts|@wispace/chat-metering/adapters|RedisBurstReconciler',
  'apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-quota-event-cleanup-cron.service.ts|@wispace/cleanup-cron/adapters|CleanupCronService',
  'apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-quota-stuck-recovery-cron.service.ts|@wispace/bot-common/locks|PgAdvisoryLockService',
  'apps/messenger-bot/src/modules/display-name/application/user-display-name.service.ts|@messenger/infrastructure/database/entities/user.entity|UserEntity',
  'apps/messenger-bot/src/modules/display-name/application/user-display-name.service.ts|@nestjs/typeorm|InjectRepository',
  'apps/messenger-bot/src/modules/display-name/application/user-display-name.service.ts|typeorm|In,Repository',
  'apps/messenger-bot/src/modules/llm-execution/application/services/llm-execution.service.ts|ioredis|Redis',
  'apps/messenger-bot/src/modules/llm-usage/application/services/llm-usage-cleanup-cron.service.ts|@wispace/cleanup-cron/adapters|CleanupCronService',
  'apps/messenger-bot/src/modules/messenger/application/agent/messenger-agent-tools.service.ts|@wispace/wispace-client/core|MemoizedWispaceGoalsService,PrecreateExerciseApiClient',
  'apps/messenger-bot/src/modules/messenger/application/agent/messenger-agent.service.ts|@wispace/chat-agent|PlatformAgentService',
  'apps/messenger-bot/src/modules/messenger/application/services/chat-history-store-startup.service.ts|../../infrastructure/persistence/chat-history.store.resolver|ChatHistoryStoreResolver',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-chat-processor.service.ts|../../infrastructure/adapters/messenger-chat-pipeline-adapters|createMessengerChatPipelineAdapters',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-chat-processor.service.ts|@wispace/chat-agent|PlatformChatHistoryService,readChatFlushRetrySettings,ChatRuntimeConfig',
  // #995: the chat privacy path owns the durable cleanup request and consumes
  // the shared persistence contract at this application boundary.
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-chat-processor.service.ts|@wispace/database|PRIVACY_CLEANUP_STORES,PrivacyDataService,PrivacyExpectedMapping',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-chat-processor.service.ts|@wispace/llm-agent/adapters|PrivacyStateService',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-link-context.service.ts|../../infrastructure/wispace/wispace-messenger-token-verify.service|WispaceMessengerTokenVerifyService',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-link-reconcile-cron.service.ts|@wispace/bot-common/locks|PgAdvisoryLockService',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-link-reconcile-cron.service.ts|@wispace/database|PlatformLinkStateService',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-link-reconcile-cron.service.ts|@wispace/wispace-client/core|WispaceLinkStatusClient',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-mapping.service.ts|@wispace/database|PlatformLinkStateService,NotificationPreferenceService',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-message-log-cleanup.service.ts|@wispace/cleanup-cron/adapters|CleanupCronService',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-outbound.service.ts|../../infrastructure/meta/messenger-platform-connectivity.service|MessengerPlatformConnectivityService',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-outbound.service.ts|@wispace/database|PlatformDeadLetterService',
  'apps/messenger-bot/src/modules/messenger/application/services/webhook-action-executor.service.ts|@wispace/database|NotificationPreferenceService',
  'apps/messenger-bot/src/modules/scheduler/application/services/data-quality-cron.service.ts|@wispace/ops-health/adapters|isDataQualityCronEnabled',
  'apps/messenger-bot/src/modules/scheduler/application/services/data-quality-cron.service.ts|@wispace/ops-health/core|DataQualityService',
  'apps/messenger-bot/src/modules/scheduler/application/services/llm-safety.service.ts|@nestjs/typeorm|InjectRepository',
  'apps/messenger-bot/src/modules/scheduler/application/services/llm-safety.service.ts|@wispace/chat-metering/adapters|LlmSafetyEventEntity,LlmSafetyEventRepository',
  'apps/messenger-bot/src/modules/scheduler/application/services/llm-safety.service.ts|typeorm|Repository',
  'apps/messenger-bot/src/modules/scheduler/application/services/report-cron.service.ts|@wispace/database|CanonicalPlatformService,WebActivityService',
  'apps/messenger-bot/src/modules/scheduler/application/services/report-cron.service.ts|@wispace/scheduler-core/adapters|ReportCronLeaderService,ReportCronLockService,ReportScheduleService',
  'apps/messenger-bot/src/modules/scheduler/application/services/report-send-orchestration.service.ts|@wispace/scheduler-core/adapters|ReportSendScheduleService',
  'apps/messenger-bot/src/modules/scheduler/application/services/report-send-retry-dispatch.service.ts|@wispace/bot-common/locks|PgAdvisoryLockService',
  'apps/messenger-bot/src/modules/scheduler/application/services/report-send-retry-dispatch.service.ts|@wispace/scheduler-core/adapters|ReportCronLeaderService,ReportScheduleService,ReportSendScheduleService',
  'apps/messenger-bot/src/modules/student-report/application/services/student-report.service.ts|../../infrastructure/wispace/task-score-average-api.service|TaskScoreAverageApiService',
  'apps/messenger-bot/src/modules/study-reminder/application/services/study-reminder.service.ts|@wispace/study-reminder-shared/adapters|StudyReminderScheduleService',
  'apps/messenger-bot/src/modules/study-reminder/application/services/study-session-source.service.ts|../../infrastructure/wispace/user-calendar-schedule.service|UserCalendarScheduleService',
  'apps/messenger-bot/src/modules/study-reminder/application/services/study-session-source.service.ts|@wispace/study-reminder-shared/adapters|StudyReminderScheduleService',
  'apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat.service.ts|@wispace/chat-agent|PlatformChatQueueService',
  'apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat.service.ts|@wispace/database|NotificationPreferenceService',
  'apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-outbound.service.ts|@wispace/database|DeliveryLogService,PlatformDeadLetterService',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-account-link.service.ts|@nestjs/typeorm|InjectRepository',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-account-link.service.ts|@wispace/study-reminder-shared/adapters|cancelStudyReminderJobsForOwnershipChange,nextMappingGenerationAfterTombstone',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-account-link.service.ts|@zalo/infrastructure/database/entities/zalo-account-link.entity|ZaloAccountLinkEntity',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-account-link.service.ts|typeorm|Repository',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-link-completion.service.ts|@wispace/database|PlatformLinkStateService',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-link-completion.service.ts|@wispace/wispace-client/adapters|WispaceTokenVerifyService',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-link-reconcile-cron.service.ts|@wispace/bot-common/locks|PgAdvisoryLockService',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-link-reconcile-cron.service.ts|@wispace/database|PlatformLinkStateService',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-link-reconcile-cron.service.ts|@wispace/wispace-client/core|WispaceLinkStatusClient',
]);

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
    allow: isLegacyApplicationImport,
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

function isLegacyApplicationImport(relativePath, imported) {
  return LEGACY_APPLICATION_IMPORTS.has(
    `${relativePath}|${imported.imported}|${imported.symbols.join(',')}`,
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

// scripts/*.mjs and apps/*/scripts/*.mjs require() built packages, so the AST
// walk over .ts never sees them. Without this pass a bare root specifier
// re-enters through the smoke scripts and only fails when a CI job runs it
// against a live Postgres.
const SCRIPT_REQUIRE = /(?:module\.)?require\(\s*['"](@wispace\/[^'"]+)['"]\s*\)/g;

function scriptRootEntrypointViolations(rootDir) {
  const violations = [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.name.endsWith('.mjs') || entry.name.endsWith('.cjs')) {
        if (entry.name.endsWith('.test.mjs') || entry.name.endsWith('.spec.mjs')) {
          continue;
        }
        files.push(fullPath);
      }
    }
  };
  for (const directory of ['scripts', 'apps']) {
    const fullPath = path.join(rootDir, directory);
    if (existsSync(fullPath)) visit(fullPath);
  }

  for (const file of files) {
    const relativePath = path
      .relative(rootDir, file)
      .replaceAll(path.sep, '/');
    readFileSync(file, 'utf8').split('\n').forEach((text, index) => {
      for (const [, specifier] of text.matchAll(SCRIPT_REQUIRE)) {
        if (!ROOT_SPECIFIER.test(specifier)) continue;
        violations.push({
          rule: 'no-root-package-entrypoint',
          package: ownerOf(relativePath),
          file: relativePath,
          line: index + 1,
          imported: specifier,
          symbols: ['require'],
          message:
            'shared packages publish explicit /core and /adapters subpaths; require the narrowest subpath instead of the package root',
        });
      }
    });
  }
  return violations;
}

export function checkArchitecture(rootDir) {
  const absoluteRoot = path.resolve(rootDir);
  const violations = scriptRootEntrypointViolations(absoluteRoot);
  let scannedFiles = 0;

  for (const file of sourceFiles(absoluteRoot)) {
    scannedFiles += 1;
    const relativePath = path
      .relative(absoluteRoot, file)
      .replaceAll(path.sep, '/');
    const source = readFileSync(file, 'utf8');
    const imports = importedModules(file, source);

    for (const imported of imports) {
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
