// Types
export * from './types/study-reminder.types';

// Pure scheduling math
export {
  computeRemindAt,
  formatScheduledTimeLabel,
  getMinutesUntilSession,
  isSessionStarted,
} from './utils/schedule';

// Ports
export * from './ports/message-sender.port';
export * from './ports/mapping-reader.port';
export * from './ports/study-reminder-job.repository.port';
export * from './ports/dispatch-hooks.port';
export * from './ports/get-sessions.port';
export * from './ports/study-calendar.port';

// Entities
export { StudyReminderJobEntity } from './entities/study-reminder-job.entity';

// Infrastructure
export { TypeormStudyReminderJobRepository } from './infrastructure/typeorm-study-reminder-job.repository';
export { TypeormMappingReader } from './infrastructure/typeorm-mapping-reader';

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
  type CanonicalPlatformResolver,
  type StudyReminderSyncOptions,
} from './services/study-reminder-sync.service';
export {
  StudyReminderDispatchService,
  DORMANT_REASON,
  type StudyReminderDispatchServiceOptions,
  type StudyReminderDispatchResult,
  type StudyReminderDispatchFailure,
} from './services/study-reminder-dispatch.service';
export {
  StudyReminderWorkerService,
  studyReminderLockSkipsTotal,
  type StudyReminderWorkerLockIds,
  type StudyReminderWorkerOptions,
} from './services/study-reminder-worker.service';
export {
  PlatformStudyCalendarCommandService,
  type PlatformStudyCalendarCommandOptions,
} from './services/platform-study-calendar-command.service';

// Factories
export {
  createStudyReminderProviders,
  createCalendarGetSessions,
  createSessionSourceGetSessions,
  type CreateStudyReminderProvidersOptions,
} from './services/study-reminder-providers.factory';
