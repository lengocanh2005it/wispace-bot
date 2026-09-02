export {
  WebhookDeadLetterEntity,
  type WebhookDeadLetterEntry,
} from './entities/webhook-dead-letter.entity';
export { WebhookInboundEventEntity } from './entities/webhook-inbound-event.entity';
export { ScheduledReportClaimEntity } from './entities/scheduled-report-claim.entity';
export { ReportSendJobEntity } from './entities/report-send-job.entity';
export { RescheduleConfirmationEntity } from './entities/reschedule-confirmation.entity';
export { CronLeaderLeaseEntity } from './entities/cron-leader-lease.entity';
export { LearnerProfileEntity } from './entities/learner-profile.entity';
export { UserNotificationPreferenceEntity } from './entities/user-notification-preference.entity';
export { PlatformLinkAuditEventEntity } from './entities/platform-link-audit-event.entity';
export {
  SHARED_ENTITIES,
  getTypeOrmOptions,
  getPostgresSsl,
  buildCliDataSource,
  readMigrationLockId,
  readEnv,
  type EntityClass,
  type EnvSource,
  type TypeOrmOptionOverrides,
} from './typeorm-options';
export {
  DEFAULT_MIGRATION_LOCK_ID,
  guardDataSourceMigrations,
  runWithMigrationAdvisoryLock,
} from './migration-data-source';
export {
  attachDbCircuitBreaker,
  getDbCircuitBreaker,
  readDbCircuitBreakerOptions,
  createCircuitBreakerDataSourceFactory,
  DbCircuitBreakerService,
  type DbCircuitBreakerOptions,
  type CircuitBreakerProtectedDataSource,
} from './db-circuit-breaker';

// Persistence-only types owned by this package — cross-context contracts
// (Platform, PlatformLinkState, ReportSendJobStatus, OutboundDeliveryOutcome,
// MessageType) are owned by @wispace/contracts and must not be re-exported here.
export {
  type PlatformLinkObservation,
  type PlatformLinkAuditEventType,
  type ScheduledReportClaimStatus,
  type WebhookDeadLetterStatus,
  type WebhookInboundEventStatus,
} from './types';
export {
  PlatformLinkStateService,
  type PlatformLinkRow,
  type PlatformLinkTransition,
  type PlatformLinkStatusReader,
} from './services/platform-link-state.service';

export { PlatformDeadLetterService } from './services/platform-dead-letter.service';
export {
  PlatformDeadLetterCronService,
  type DeadLetterCronOptions,
} from './services/platform-dead-letter-cron.service';
export {
  DeliveryLogService,
  type MessageLogRow,
} from './services/delivery-log.service';
export { PlatformReportClaimRepository } from './services/platform-report-claim.repository';
export {
  DEFAULT_REPORT_CLAIM_LEASE_MS,
  ReportClaimStaleResetCronService,
  readReportClaimLeaseMs,
  type ReportClaimStaleResetCronOptions,
} from './services/report-claim-stale-reset-cron.service';
export { TypeormRescheduleStore } from './services/typeorm-reschedule-store';
export { RescheduleRecoveryCronService } from './services/reschedule-recovery-cron.service';
export { CronLeaderLeaseService } from './services/cron-leader-lease.service';
export { listUserIdsWithSentReport } from './services/list-user-ids-with-sent-report';
export {
  PrivacyDataService,
  type ChatHistoryClearer,
  type PrivacyEntityRegistry,
  type PrivacyEntityTarget,
  type PrivacyScopedEntities,
  type PrivacyStateCleanup,
  type PrivacyExportData,
  type PrivacyUnlinkResult,
} from './services/privacy-data.service';
export {
  CanonicalPlatformService,
  resolveCanonicalPlatform,
  DEFAULT_PLATFORM_PRIORITY,
} from './services/canonical-platform.service';
export { NotificationPreferenceService } from './services/notification-preference.service';
export {
  WebActivityService,
  normalizeToUtcIso,
} from './services/web-activity.service';
export { WebActivityEntity } from './entities/web-activity.entity';
export { UserPlatformMappingEntity } from './entities/user-platform-mapping.entity';
export { DiscordAccountLinkEntity } from './entities/discord-account-link.entity';
export { ZaloAccountLinkEntity } from './entities/zalo-account-link.entity';
