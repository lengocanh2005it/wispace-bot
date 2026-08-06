// Types
export * from './types/study-reminder.types';

// Ports
export * from './ports/message-sender.port';
export * from './ports/mapping-reader.port';
export * from './ports/display-name-cache.port';
export * from './ports/study-reminder-job.repository.port';
export * from './ports/reminder-generator.port';
export * from './ports/metrics-hook.port';
export * from './ports/error-classifier.port';

// Entities
export { StudyReminderJobEntity } from './entities/study-reminder-job.entity';

// Infrastructure
export { TypeormStudyReminderJobRepository } from './infrastructure/typeorm-study-reminder-job.repository';
export {
  TypeormMappingReader,
  type AccountLinkRow,
} from './infrastructure/typeorm-mapping-reader';

// Services
export { StudyReminderScheduleService } from './services/study-reminder-schedule.service';
export type { StudyReminderScheduleServiceOptions } from './services/study-reminder-schedule.service';
export {
  wrapMessageSender,
  type OutboundMessageSender,
} from './services/message-sender.factory';
export {
  StudyReminderSyncService,
  type OnUserSyncHook,
  type StudyReminderSyncOptions,
} from './services/study-reminder-sync.service';
export {
  StudyReminderDispatchService,
  type StudyReminderDispatchServiceOptions,
  type StudyReminderDispatchResult,
  type StudyReminderDispatchFailure,
} from './services/study-reminder-dispatch.service';
export {
  StudyReminderWorkerService,
  type StudyReminderWorkerLockIds,
  type StudyReminderWorkerOptions,
} from './services/study-reminder-worker.service';
export {
  PlatformStudyCalendarCommandService,
  type PlatformStudyCalendarCommandOptions,
} from './services/platform-study-calendar-command.service';
export {
  GenericCalendarPort,
  type ListUpcomingFn,
} from './ports/generic-calendar.port';
