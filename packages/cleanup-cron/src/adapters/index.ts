// This package is intentionally framework-bound: shared NestJS/TypeORM cron
// adapters are the public surface, with no claimed framework-free core.

export {
  CleanupCronService,
  type CleanupResult,
} from '../cleanup-cron.service';
export {
  CleanupCronPolicyRegistry,
  createCleanupCronPolicyRegistry,
  type CleanupCronPolicy,
  type CleanupRetentionPolicy,
} from '../cleanup-policy.registry';
export {
  PlatformCleanupCronService,
  type CleanupCronMetricsPort,
  type CleanupCronJobsConfig,
} from '../platform-cleanup-cron.service';
export {
  PlatformLinkAuditCleanupService,
  type PlatformLinkAuditCleanupOptions,
} from '../platform-link-audit-cleanup.service';
