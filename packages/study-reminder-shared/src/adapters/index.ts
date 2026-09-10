// NestJS, TypeORM, scheduler, metrics, and platform wiring for reminders.

export { StudyReminderJobEntity } from '../entities/study-reminder-job.entity';
export { TypeormStudyReminderJobRepository } from '../infrastructure/typeorm-study-reminder-job.repository';
export { TypeormMappingReader } from '../infrastructure/typeorm-mapping-reader';
export {
  StudyReminderScheduleService,
  type StudyReminderScheduleServiceOptions,
} from '../services/study-reminder-schedule.service';
export {
  wrapMessageSender,
  type OutboundMessageSender,
} from '../services/message-sender.factory';
export {
  StudyReminderSyncService,
  type OnUserSyncHook,
  type CanonicalPlatformResolver,
  type StudyReminderSyncOptions,
} from '../services/study-reminder-sync.service';
export {
  StudyReminderDispatchService,
  DORMANT_REASON,
  type StudyReminderDispatchServiceOptions,
  type StudyReminderDispatchResult,
  type StudyReminderDispatchFailure,
} from '../services/study-reminder-dispatch.service';
export {
  StudyReminderWorkerService,
  studyReminderLockSkipsTotal,
  type StudyReminderWorkerLockIds,
  type StudyReminderWorkerMetrics,
  type StudyReminderWorkerOptions,
} from '../services/study-reminder-worker.service';
export {
  PlatformStudyCalendarCommandService,
  type PlatformStudyCalendarCommandOptions,
} from '../services/platform-study-calendar-command.service';
export {
  createStudyReminderProviders,
  createCalendarGetSessions,
  createSessionSourceGetSessions,
  type CreateStudyReminderProvidersOptions,
} from '../services/study-reminder-providers.factory';
