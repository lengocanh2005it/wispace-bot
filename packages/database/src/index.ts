export {
  WebhookDeadLetterEntity,
  type WebhookDeadLetterEntry,
} from './entities/webhook-dead-letter.entity';
export { ScheduledReportClaimEntity } from './entities/scheduled-report-claim.entity';
export { ReportSendJobEntity } from './entities/report-send-job.entity';
export {
  SHARED_ENTITIES,
  getTypeOrmOptions,
  getPostgresSsl,
  buildCliDataSource,
  readEnv,
  type EntityClass,
} from './typeorm-options';

// Shared types
export {
  type Platform,
  type MappingStatus,
  type MessageLogStatus,
  type ChatQuotaDenyReason,
  type ChatIdempotencyStatus,
  type ChatQuotaEventType,
  type ChatQuotaReleaseReason,
  type ReportSendJobStatus,
  type ScheduledReportClaimStatus,
  type WebhookDeadLetterStatus,
  type StudyReminderJobStatus,
  type LlmFeature,
  MessageType,
  type MessageType as MessageTypeValue,
  type CalendarSessionTimeRange,
  type ReportDeliveryReason,
} from './types';

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
  createDeliveryLogProvider,
  createPlatformDeadLetterProvider,
} from './services/platform-providers.factory';
