export { WispaceApiError } from './errors/wispace-api.error';
export { withRetry, isWispaceRetryable } from './utils/with-retry';
export type { WithRetryOptions } from './utils/with-retry';
export { buildWispaceHeaders } from './utils/wispace-headers';
export type { WispaceIdHeader } from './utils/wispace-headers';
export * from './utils/study-calendar.utils';
export {
  formatLocalDate,
  getDatePartsInTimezone as getLocalDateParts,
  tomorrowInTimezone as getTomorrowLocalDate,
} from '@wispace/date-utils';

export type { UserGoalsRecord } from './types/user-goals.types';
export type { TaskScoreAverageRecord } from './types/task-score-average.types';
export type {
  CreateUserCalendarInput,
  UserCalendarRecord,
} from './types/user-calendar.types';
export type {
  CalendarSessionTimeRange,
  NormalizedStudySession,
} from './types/study-schedule.types';

export {
  normalizeCreatedCalendarRecord,
  normalizeUserCalendarRecord,
  normalizeUserCalendarRecords,
  unwrapCalendarCreatePayload,
} from './clients/user-calendar-record.normalizer';
export type {
  WispaceApiClientConfig,
  WispaceClientLogger,
} from './clients/wispace-client-types';
export { NOOP_WISPACE_LOGGER } from './clients/wispace-client-types';
export { UserGoalsApiClient } from './clients/user-goals-api.client';
export { TaskScoreAverageApiClient } from './clients/task-score-average-api.client';
export { UserCalendarApiClient } from './clients/user-calendar-api.client';
export { UserCalendarScheduleClient } from './clients/user-calendar-schedule.client';
export type { ListCalendarsFn } from './clients/user-calendar-schedule.client';
export { WispaceGoalsService } from './clients/wispace-goals.service';
export { WispaceCalendarService } from './clients/wispace-calendar.service';
export { WispaceTokenVerifyService } from './clients/wispace-token-verify.service';
export type {
  WispaceLinkVerifyFailureReason,
  WispaceLinkVerifyResult,
} from './types/token-verify.types';
export { WispaceConfigService } from './config/wispace-config.service';
