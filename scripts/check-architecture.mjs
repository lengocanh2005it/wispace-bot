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

// Ratchet baseline for existing application edges. Remove each entry as
// #429/#430 move the adapter outward; new edges fail immediately.
const LEGACY_APPLICATION_IMPORTS = new Set([
  'apps/discord-bot/src/modules/account-link/application/services/discord-link-completion.service.ts|@wispace/wispace-client|WispaceTokenVerifyService',
  'apps/discord-bot/src/modules/account-link/application/services/discord-link-completion.service.ts|@wispace/database|PlatformLinkStateService',
  'apps/discord-bot/src/modules/account-link/application/services/discord-link-reconcile-cron.service.ts|@wispace/bot-common/locks|ADVISORY_LOCKS,PgAdvisoryLockService',
  'apps/discord-bot/src/modules/account-link/application/services/discord-link-reconcile-cron.service.ts|@wispace/database|PlatformLinkStateService',
  'apps/discord-bot/src/modules/account-link/application/services/discord-link-reconcile-cron.service.ts|@wispace/wispace-client|WispaceLinkStatusClient',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-consent.service.ts|@wispace/database|NotificationPreferenceService',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-menu.service.ts|@wispace/wispace-client|WispaceApiError,WispaceCalendarService,WispaceGoalsService',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-outbound.service.ts|discord.js|ActionRowBuilder,ButtonBuilder,ButtonStyle,Client,TextChannel',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-outbound.service.ts|discord.js|MessageCreateOptions',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-outbound.service.ts|@wispace/database|DeliveryLogService,PlatformDeadLetterService',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-platform-connectivity.service.ts|discord.js|Client',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-report-cron.service.ts|@wispace/scheduler-core|ReportCronLeaderService,ReportCronLockService,ReportScheduleService,evaluateExamWindow,todayReportDate,runBatched',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-report-cron.service.ts|@wispace/database|CanonicalPlatformService,WebActivityService',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-report-orchestration.service.ts|@wispace/scheduler-core|ReportOrchestrationService',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-report-orchestration.service.ts|@wispace/student-report|isStudentReportRetryableError,PlatformStudentReportService',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-report-retry-dispatch.service.ts|@wispace/scheduler-core|REPORT_SEND_JOB_REPOSITORY,ReportCronLeaderService,ReportSendJobRepositoryPort',
  'apps/discord-bot/src/modules/discord-chat/application/services/discord-report-retry-dispatch.service.ts|@wispace/bot-common/locks|PgAdvisoryLockService,ADVISORY_LOCKS',
  'apps/discord-bot/src/modules/discord-chat/application/utils/discord-outbound-guard.ts|discord.js|MessageMentionOptions',
  'apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-idempotency-cleanup-cron.service.ts|@nestjs/typeorm|InjectRepository',
  'apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-idempotency-cleanup-cron.service.ts|typeorm|Repository',
  'apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-idempotency-cleanup-cron.service.ts|@wispace/cleanup-cron|CleanupCronService,CleanupCronConfig',
  'apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-idempotency-cleanup-cron.service.ts|@wispace/chat-metering|ChatIdempotencyEntity,ChatToolDailyUsageEntity',
  'apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-quota-event-cleanup-cron.service.ts|@wispace/cleanup-cron|CleanupCronService,CleanupCronConfig',
  'apps/messenger-bot/src/modules/chat-rate-limit/application/services/chat-quota-stuck-recovery-cron.service.ts|@wispace/bot-common/locks|PgAdvisoryLockService',
  'apps/messenger-bot/src/modules/display-name/application/user-display-name.service.ts|@nestjs/typeorm|InjectRepository',
  'apps/messenger-bot/src/modules/display-name/application/user-display-name.service.ts|typeorm|In,Repository',
  'apps/messenger-bot/src/modules/display-name/application/user-display-name.service.ts|@messenger/infrastructure/database/entities/user.entity|UserEntity',
  'apps/messenger-bot/src/modules/llm-execution/application/services/llm-execution.service.ts|ioredis|Redis',
  'apps/messenger-bot/src/modules/llm-usage/application/services/llm-usage-cleanup-cron.service.ts|@wispace/cleanup-cron|CleanupCronService,CleanupCronConfig',
  'apps/messenger-bot/src/modules/messenger/application/agent/messenger-agent-tools.service.ts|@wispace/wispace-client|MemoizedWispaceGoalsService',
  'apps/messenger-bot/src/modules/messenger/application/agent/messenger-agent-tools.service.ts|@wispace/wispace-client|PrecreateExerciseApiClient',
  'apps/messenger-bot/src/modules/messenger/application/agent/messenger-agent.service.ts|@wispace/chat-agent|PlatformAgentService',
  'apps/messenger-bot/src/modules/messenger/application/services/chat-history-store-startup.service.ts|../../infrastructure/persistence/chat-history.store.resolver|ChatHistoryStoreResolver',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-chat-processor.service.ts|@wispace/database|PrivacyDataService,PrivacyExpectedMapping',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-chat-processor.service.ts|../../infrastructure/adapters/messenger-chat-pipeline-adapters|createMessengerChatPipelineAdapters',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-chat-processor.service.ts|@wispace/chat-agent|PlatformChatHistoryService,readChatFlushRetrySettings',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-link-context.service.ts|../../infrastructure/wispace/wispace-messenger-token-verify.service|WispaceMessengerTokenVerifyService',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-link-reconcile-cron.service.ts|@wispace/bot-common/locks|PgAdvisoryLockService',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-link-reconcile-cron.service.ts|@wispace/database|PlatformLinkStateService',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-link-reconcile-cron.service.ts|@wispace/wispace-client|WispaceLinkStatusClient',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-mapping.service.ts|@wispace/study-reminder-shared|createSessionSourceGetSessions,StudyReminderSyncService',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-mapping.service.ts|@wispace/database|PlatformLinkStateService,NotificationPreferenceService',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-message-log-cleanup.service.ts|@wispace/cleanup-cron|CleanupCronService,CleanupCronConfig',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-outbound.service.ts|@wispace/database|PlatformDeadLetterService',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-outbound.service.ts|../../infrastructure/meta/messenger-platform-connectivity.service|MessengerPlatformConnectivityService',
  'apps/messenger-bot/src/modules/messenger/application/services/messenger-reminder-delivery.service.ts|@wispace/study-reminder-shared|StudyReminderScheduleService',
  'apps/messenger-bot/src/modules/messenger/application/services/webhook-action-executor.service.ts|@wispace/database|NotificationPreferenceService',
  'apps/messenger-bot/src/modules/scheduler/application/services/data-quality-cron.service.ts|@wispace/ops-health|isDataQualityCronEnabled,DataQualityService,DataQualityCheckResult',
  'apps/messenger-bot/src/modules/scheduler/application/services/llm-safety.service.ts|@nestjs/typeorm|InjectRepository',
  'apps/messenger-bot/src/modules/scheduler/application/services/llm-safety.service.ts|typeorm|Repository',
  'apps/messenger-bot/src/modules/scheduler/application/services/llm-safety.service.ts|@wispace/chat-metering|LlmSafetyCore,LlmSafetyEventEntity,LlmSafetyEventRepository',
  'apps/messenger-bot/src/modules/scheduler/application/services/report-cron.service.ts|@wispace/database|CanonicalPlatformService,WebActivityService',
  'apps/messenger-bot/src/modules/scheduler/application/services/report-cron.service.ts|@wispace/scheduler-core|ReportCronLeaderService,ReportCronLockService,ReportScheduleService,todayReportDate,runBatched,SendScheduledReportsOptions,SendScheduledReportsResult',
  'apps/messenger-bot/src/modules/scheduler/application/services/report-send-orchestration.service.ts|@wispace/database|readReportClaimLeaseMs',
  'apps/messenger-bot/src/modules/scheduler/application/services/report-send-orchestration.service.ts|@wispace/scheduler-core|ReportSendScheduleService',
  'apps/messenger-bot/src/modules/scheduler/application/services/report-send-retry-dispatch.service.ts|@wispace/scheduler-core|REPORT_SEND_JOB_REPOSITORY,ReportSendJobRepositoryPort,ReportCronLeaderService,ReportScheduleService,ReportSendScheduleService,todayReportDate',
  'apps/messenger-bot/src/modules/scheduler/application/services/report-send-retry-dispatch.service.ts|@wispace/bot-common/locks|PgAdvisoryLockService',
  'apps/messenger-bot/src/modules/student-report/application/services/student-report.service.ts|../../infrastructure/wispace/task-score-average-api.service|TaskScoreAverageApiService',
  'apps/messenger-bot/src/modules/study-reminder/application/services/study-calendar-command.service.ts|@wispace/study-reminder-shared|StudyReminderScheduleService',
  'apps/messenger-bot/src/modules/study-reminder/application/services/study-calendar-command.service.ts|@wispace/study-reminder-shared|StudyReminderSyncService',
  'apps/messenger-bot/src/modules/study-reminder/application/services/study-reminder.service.ts|@wispace/study-reminder-shared|StudyReminderScheduleService',
  'apps/messenger-bot/src/modules/study-reminder/application/services/study-session-source.service.ts|@wispace/study-reminder-shared|StudyReminderScheduleService',
  'apps/messenger-bot/src/modules/study-reminder/application/services/study-session-source.service.ts|../../infrastructure/wispace/user-calendar-schedule.service|UserCalendarScheduleService',
  'apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat.service.ts|@wispace/database|NotificationPreferenceService',
  'apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-chat.service.ts|@wispace/chat-agent|PlatformChatQueueService',
  'apps/zalo-bot/src/modules/zalo-chat/application/services/zalo-outbound.service.ts|@wispace/database|DeliveryLogService,PlatformDeadLetterService',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-account-link.service.ts|@nestjs/typeorm|InjectRepository',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-account-link.service.ts|typeorm|Repository',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-account-link.service.ts|@zalo/infrastructure/database/entities/zalo-account-link.entity|ZaloAccountLinkEntity',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-link-completion.service.ts|@wispace/wispace-client|WispaceTokenVerifyService',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-link-completion.service.ts|@wispace/database|PlatformLinkStateService',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-link-reconcile-cron.service.ts|@wispace/bot-common/locks|PgAdvisoryLockService',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-link-reconcile-cron.service.ts|@wispace/database|PlatformLinkStateService',
  'apps/zalo-bot/src/modules/zalo-oauth/application/services/zalo-link-reconcile-cron.service.ts|@wispace/wispace-client|WispaceLinkStatusClient',
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
